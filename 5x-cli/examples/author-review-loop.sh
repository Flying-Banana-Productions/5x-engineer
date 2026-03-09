#!/usr/bin/env bash
#
# Minimal author/review loop using 5x CLI primitives.
#
# Demonstrates a single-phase workflow with composable piping:
#   1. Initialize a run
#   2. Invoke the author agent (auto-records via --record)
#   3. Run quality gates (pipe result to run record)
#   4. Invoke the reviewer agent (auto-records via --record)
#   5. If not ready, prompt the user for guidance on human_required items,
#      then feed review back to the author and repeat
#   6. Complete the run
#
# Composability patterns used:
#   - `--record` flag: invoke auto-records the step using the template's
#     step_name from frontmatter — no manual `run record` call needed.
#   - Pipe to `run record`: quality output piped directly, with step name
#     and --run from CLI flags (quality has no template step_name).
#   - `jq` for branching: extract result fields to decide next action.
#
# Requirements: 5x-cli, jq, a configured 5x.toml
#
# Usage:
#   ./examples/author-review-loop.sh docs/development/001-impl-example.md
#
set -euo pipefail

PLAN="${1:?Usage: $0 <plan-path>}"
MAX_REVIEW_CYCLES=3

# ---------------------------------------------------------------------------
# 1. Initialize the run
# ---------------------------------------------------------------------------

echo "--- Initializing run for $PLAN ---"
INIT_OUT=$(5x run init --plan "$PLAN" --allow-dirty)
RUN_ID=$(echo "$INIT_OUT" | jq -r '.data.run_id')
echo "Run ID: $RUN_ID"

# ---------------------------------------------------------------------------
# 2. Determine the next incomplete phase
# ---------------------------------------------------------------------------

PHASES_OUT=$(5x plan phases "$PLAN")
PHASE=$(echo "$PHASES_OUT" | jq -r '[.data.phases[] | select(.done == false)][0].id // empty')
if [ -z "$PHASE" ]; then
  echo "All phases complete."
  5x run complete --run "$RUN_ID"
  exit 0
fi
echo "Working on phase: $PHASE"

# ---------------------------------------------------------------------------
# 3. Author implementation
#    --record auto-records using the template's step_name ("author:implement")
# ---------------------------------------------------------------------------

echo "--- Invoking author (phase $PHASE) ---"
AUTHOR_OUT=$(5x invoke author author-next-phase \
  --run "$RUN_ID" \
  --record --phase "$PHASE" \
  --var "plan_path=$PLAN" \
  --var "phase_number=$PHASE")

# jq for branching: inspect the result to decide next action
AUTHOR_RESULT=$(echo "$AUTHOR_OUT" | jq -r '.data.result.result')
echo "Author result: $AUTHOR_RESULT"

if [ "$AUTHOR_RESULT" != "complete" ]; then
  echo "Author did not complete. Reason: $(echo "$AUTHOR_OUT" | jq -r '.data.result.reason')"
  5x run complete --run "$RUN_ID" --status aborted --reason "Author: $AUTHOR_RESULT"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Quality gates
#    Pipe quality output directly to `run record` — step name and --run
#    provided as CLI args since quality has no template step_name.
# ---------------------------------------------------------------------------

echo "--- Running quality gates ---"
QUALITY_OUT=$(5x quality run)

# Pipe to record: quality envelope -> run record extracts result automatically
echo "$QUALITY_OUT" | 5x run record "quality:check" \
  --run "$RUN_ID" --phase "$PHASE" > /dev/null

QUALITY_PASSED=$(echo "$QUALITY_OUT" | jq -r '.data.passed')
echo "Quality gates passed: $QUALITY_PASSED"

if [ "$QUALITY_PASSED" != "true" ]; then
  echo "Quality gates failed. Aborting."
  5x run complete --run "$RUN_ID" --status aborted --reason "Quality gates failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. Review loop
# ---------------------------------------------------------------------------

for i in $(seq 1 "$MAX_REVIEW_CYCLES"); do
  echo "--- Review cycle $i/$MAX_REVIEW_CYCLES ---"

  # Reviewer uses commit_hash to examine changes directly via git
  COMMIT_HASH=$(git rev-parse HEAD)

  # --record auto-records using the template's step_name ("reviewer:review")
  REVIEW_OUT=$(5x invoke reviewer reviewer-commit \
    --run "$RUN_ID" \
    --record --phase "$PHASE" --iteration "$i" \
    --var "commit_hash=$COMMIT_HASH" \
    --var "plan_path=$PLAN" \
    --var "review_path=.5x/reviews/phase-${PHASE}-review.md" \
    --var "review_template_path=.5x/templates/review.md")

  READINESS=$(echo "$REVIEW_OUT" | jq -r '.data.result.readiness')
  echo "Reviewer verdict: $READINESS"

  if [ "$READINESS" = "ready" ]; then
    echo "Approved!"
    break
  fi

  if [ "$i" -eq "$MAX_REVIEW_CYCLES" ]; then
    echo "Max review cycles reached without approval."
    5x run complete --run "$RUN_ID" --status aborted --reason "Review limit reached"
    exit 1
  fi

  # Split review items by action type
  ITEMS=$(echo "$REVIEW_OUT" | jq -c '.data.result.items')
  HUMAN_REQ=$(echo "$ITEMS" | jq -c '[.[] | select(.action == "human_required")]')
  HUMAN_COUNT=$(echo "$HUMAN_REQ" | jq 'length')

  # -----------------------------------------------------------------------
  # Handle human_required items: prompt the user for guidance on each one
  # -----------------------------------------------------------------------
  USER_NOTES=""
  if [ "$HUMAN_COUNT" -gt 0 ]; then
    echo ""
    echo "The reviewer flagged $HUMAN_COUNT item(s) requiring human judgment:"
    echo "$HUMAN_REQ" | jq -r '.[] | "  [\(.id)] \(.title) (\(.priority // "P1"))\n         \(.reason)\n"'

    # Ask the user what to do
    CHOICE_OUT=$(5x prompt choose \
      "How do you want to handle these items?" \
      --options "provide guidance,skip and let author decide,abort run")
    CHOICE=$(echo "$CHOICE_OUT" | jq -r '.data.answer')

    case "$CHOICE" in
      "provide guidance")
        echo "Enter guidance for the author (press Ctrl+D when done):"
        GUIDANCE_OUT=$(5x prompt input "Guidance for human_required items" --multiline)
        USER_NOTES=$(echo "$GUIDANCE_OUT" | jq -r '.data.answer')
        ;;
      "skip and let author decide")
        USER_NOTES="Human items deferred to author's best judgment."
        ;;
      "abort run")
        5x run complete --run "$RUN_ID" --status aborted --reason "Human declined to resolve review items"
        exit 1
        ;;
    esac

    5x run record "human:gate" \
      --run "$RUN_ID" \
      --phase "$PHASE" \
      --iteration "$i" \
      --result "$(jq -nc --arg choice "$CHOICE" --arg notes "$USER_NOTES" \
        '{action: $choice, notes: $notes}')" > /dev/null
  fi

  # -----------------------------------------------------------------------
  # Feed review back to author for fixes
  # --record auto-records using the template's step_name ("author:fix-review")
  # -----------------------------------------------------------------------
  TOTAL_ITEMS=$(echo "$ITEMS" | jq 'length')
  echo "Sending $TOTAL_ITEMS review item(s) back to author..."

  FIX_VARS=(
    --var "plan_path=$PLAN"
    --var "review_path=.5x/reviews/phase-${PHASE}-review.md"
  )
  if [ -n "$USER_NOTES" ]; then
    FIX_VARS+=(--var "user_notes=$USER_NOTES")
  fi

  5x invoke author author-process-impl-review \
    --run "$RUN_ID" \
    --record --phase "$PHASE" --iteration "$i" \
    "${FIX_VARS[@]}" > /dev/null
done

# ---------------------------------------------------------------------------
# 6. Complete the run
# ---------------------------------------------------------------------------

echo "--- Completing run $RUN_ID ---"
5x run complete --run "$RUN_ID"
echo "Done."

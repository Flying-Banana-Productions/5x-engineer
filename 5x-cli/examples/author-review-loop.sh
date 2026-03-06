#!/usr/bin/env bash
#
# Minimal author/review loop using 5x CLI primitives.
#
# Demonstrates a single-phase workflow:
#   1. Initialize a run
#   2. Invoke the author agent
#   3. Run quality gates
#   4. Invoke the reviewer agent
#   5. If not ready, prompt the user for guidance on human_required items,
#      then feed review back to the author and repeat
#   6. Complete the run
#
# Requirements: 5x-cli, jq, a configured 5x.config.js
#
# Usage:
#   ./examples/author-review-loop.sh docs/development/001-impl-example.md
#
set -euo pipefail

PLAN="${1:?Usage: $0 <plan-path>}"
MAX_REVIEW_CYCLES=3

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Extract .data from a 5x JSON envelope, or print the error and exit.
unwrap() {
  local json="$1"
  local ok
  ok=$(echo "$json" | jq -r '.ok')
  if [ "$ok" != "true" ]; then
    echo "$json" | jq -r '.error.message' >&2
    exit 1
  fi
  echo "$json" | jq '.data'
}

# ---------------------------------------------------------------------------
# 1. Initialize the run
# ---------------------------------------------------------------------------

echo "--- Initializing run for $PLAN ---"
INIT_OUT=$(5x run init --plan "$PLAN" --allow-dirty)
INIT=$(unwrap "$INIT_OUT")

RUN_ID=$(echo "$INIT" | jq -r '.run_id')
echo "Run ID: $RUN_ID"

# ---------------------------------------------------------------------------
# 2. Determine the next incomplete phase
# ---------------------------------------------------------------------------

PHASES_OUT=$(5x plan phases "$PLAN")
PHASES=$(unwrap "$PHASES_OUT")

PHASE=$(echo "$PHASES" | jq -r '[.phases[] | select(.done == false)][0].id // empty')
if [ -z "$PHASE" ]; then
  echo "All phases complete."
  5x run complete --run "$RUN_ID"
  exit 0
fi
echo "Working on phase: $PHASE"

# ---------------------------------------------------------------------------
# 3. Author implementation
# ---------------------------------------------------------------------------

echo "--- Invoking author (phase $PHASE) ---"
AUTHOR_OUT=$(5x invoke author author-next-phase \
  --run "$RUN_ID" \
  --var "plan_path=$PLAN" \
  --var "phase_number=$PHASE")
AUTHOR=$(unwrap "$AUTHOR_OUT")

AUTHOR_RESULT=$(echo "$AUTHOR" | jq -r '.result.result')
echo "Author result: $AUTHOR_RESULT"

# Record the step
5x run record "author:implement" \
  --run "$RUN_ID" \
  --phase "$PHASE" \
  --result "$(echo "$AUTHOR" | jq -c '.result')" \
  --session-id "$(echo "$AUTHOR" | jq -r '.session_id')" \
  --duration-ms "$(echo "$AUTHOR" | jq -r '.duration_ms')" \
  --tokens-in "$(echo "$AUTHOR" | jq -r '.tokens.in')" \
  --tokens-out "$(echo "$AUTHOR" | jq -r '.tokens.out')" \
  --log-path "$(echo "$AUTHOR" | jq -r '.log_path')" > /dev/null

if [ "$AUTHOR_RESULT" != "complete" ]; then
  echo "Author did not complete. Reason: $(echo "$AUTHOR" | jq -r '.result.reason')"
  5x run complete --run "$RUN_ID" --status aborted --reason "Author: $AUTHOR_RESULT"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Quality gates
# ---------------------------------------------------------------------------

echo "--- Running quality gates ---"
QUALITY_OUT=$(5x quality run)
QUALITY=$(unwrap "$QUALITY_OUT")

QUALITY_PASSED=$(echo "$QUALITY" | jq -r '.passed')
echo "Quality gates passed: $QUALITY_PASSED"

5x run record "quality:check" \
  --run "$RUN_ID" \
  --phase "$PHASE" \
  --result "$(echo "$QUALITY" | jq -c '.')" > /dev/null

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

  DIFF_OUT=$(5x diff)
  DIFF=$(unwrap "$DIFF_OUT")
  DIFF_TEXT=$(echo "$DIFF" | jq -r '.diff')

  REVIEW_OUT=$(5x invoke reviewer reviewer-commit \
    --run "$RUN_ID" \
    --var "plan_path=$PLAN" \
    --var "phase_number=$PHASE" \
    --var "diff=$DIFF_TEXT")
  REVIEW=$(unwrap "$REVIEW_OUT")

  READINESS=$(echo "$REVIEW" | jq -r '.result.readiness')
  echo "Reviewer verdict: $READINESS"

  5x run record "reviewer:review" \
    --run "$RUN_ID" \
    --phase "$PHASE" \
    --iteration "$i" \
    --result "$(echo "$REVIEW" | jq -c '.result')" \
    --session-id "$(echo "$REVIEW" | jq -r '.session_id')" \
    --duration-ms "$(echo "$REVIEW" | jq -r '.duration_ms')" \
    --tokens-in "$(echo "$REVIEW" | jq -r '.tokens.in')" \
    --tokens-out "$(echo "$REVIEW" | jq -r '.tokens.out')" \
    --log-path "$(echo "$REVIEW" | jq -r '.log_path')" > /dev/null

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
  ITEMS=$(echo "$REVIEW" | jq -c '.result.items')
  AUTO_FIX=$(echo "$ITEMS" | jq -c '[.[] | select(.action == "auto_fix")]')
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
    CHOICE=$(unwrap "$CHOICE_OUT" | jq -r '.answer')

    case "$CHOICE" in
      "provide guidance")
        echo "Enter guidance for the author (press Ctrl+D when done):"
        GUIDANCE_OUT=$(5x prompt input "Guidance for human_required items" --multiline)
        USER_NOTES=$(unwrap "$GUIDANCE_OUT" | jq -r '.answer')
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
  # Feed review items (+ human guidance) back to author for fixes
  # -----------------------------------------------------------------------
  TOTAL_ITEMS=$(echo "$ITEMS" | jq 'length')
  echo "Sending $TOTAL_ITEMS review item(s) back to author..."

  # Build --var args for the fix invocation
  FIX_VARS=(
    --var "plan_path=$PLAN"
    --var "phase_number=$PHASE"
    --var "review_items=$ITEMS"
  )
  if [ -n "$USER_NOTES" ]; then
    FIX_VARS+=(--var "user_notes=$USER_NOTES")
  fi

  FIX_OUT=$(5x invoke author author-process-impl-review \
    --run "$RUN_ID" \
    "${FIX_VARS[@]}")
  FIX=$(unwrap "$FIX_OUT")

  5x run record "author:fix-review" \
    --run "$RUN_ID" \
    --phase "$PHASE" \
    --iteration "$i" \
    --result "$(echo "$FIX" | jq -c '.result')" > /dev/null
done

# ---------------------------------------------------------------------------
# 6. Complete the run
# ---------------------------------------------------------------------------

echo "--- Completing run $RUN_ID ---"
5x run complete --run "$RUN_ID"
echo "Done."

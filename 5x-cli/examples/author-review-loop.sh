#!/usr/bin/env bash
# One phase of a fresh execution run, using configured invoke providers.
# Requires Bash, jq, Git, 5x, an approved plan, and invoke delegation for both roles.
# Ordinary fixes loop through fresh quality + review. Human gates, specialized
# corrections, amendments, failures, and existing runs hand off to the installed
# 5x-phase-execution skill. See docs/automation.md; this is not a resume engine.
# Usage: bash examples/author-review-loop.sh docs/development/my-feature.md
set -euo pipefail

PLAN="${1:?Usage: $0 <approved-plan-path>}"
for tool in 5x jq git; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }
done
[[ -f "$PLAN" ]] || { printf 'Plan must exist locally: %s\n' "$PLAN" >&2; exit 1; }

# Preserve stderr and expose captured error envelopes. Always override a user's
# FIVEX_OUTPUT_FORMAT=text preference. Process failure wins over an ok envelope
# (invoke can emit a result before its recording side effect fails).
fivex() {
  local output status
  if output=$(5x "$@" --json); then
    printf '%s\n' "$output"
  else
    status=$?
    printf '%s\n' "$output" >&2
    return "$status"
  fi
}

pause() {
  printf '%s\nResume with the installed 5x-phase-execution skill and inspect run state.\n' "$1" >&2
  exit 1
}

CONFIG=$(fivex config show --context "$(dirname "$PLAN")")
config_value() {
  printf '%s\n' "$CONFIG" | jq -er --arg key "$1" '.data.entries[] | select(.key == $key) | .value'
}
[[ $(config_value author.delegationMode) == invoke && $(config_value reviewer.delegationMode) == invoke ]] ||
  pause 'This shell example requires both roles configured for invoke. Use the native skill otherwise.'
MAX_REVIEWS=$(config_value maxReviewIterations)

INITIAL_PHASES=$(fivex plan phases "$PLAN")
PHASE=$(printf '%s\n' "$INITIAL_PHASES" | jq -r '[.data.phases[] | select(.done == false)][0].id // empty')
[[ -n "$PHASE" ]] || pause 'No pending phase. Check review/governance state before completing any run.'
PHASE_IDS=$(printf '%s\n' "$INITIAL_PHASES" | jq -c '[.data.phases[].id]')

# Shared-checkout safety is intentional; no automatic --allow-dirty opt-out.
# Existing worktree mappings still resolve through --run on subsequent commands.
INIT=$(fivex run init --plan "$PLAN")
printf '%s\n' "$INIT" | jq '.data | {warnings, harness_freshness} | with_entries(select(.value != null))' >&2
RUN_ID=$(printf '%s\n' "$INIT" | jq -er '.data.run_id')
export FIVEX_RUN="$RUN_ID"
FINISHED=false
checkpoint_on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$FINISHED" == false ]]; then
    if ! fivex commit --run "$RUN_ID" --no-record -m "5x: checkpoint run records"; then
      printf 'Record checkpoint failed; inspect run %s before handoff.\n' "$RUN_ID" >&2
      status=1
    fi
  fi
  exit "$status"
}
trap checkpoint_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ $(printf '%s\n' "$INIT" | jq -r '.data.resumed') == false ]] ||
  pause "Run $RUN_ID already exists. Refusing to replay its step identities."

TEMPLATE=author-next-phase
APPROVED=false
for (( ITERATION=1; ITERATION<=MAX_REVIEWS; ITERATION++ )); do
  AUTHOR=$(fivex invoke author "$TEMPLATE" --run "$RUN_ID" \
    --var "phase_number=$PHASE" --new-session --record \
    --phase "$PHASE" --iteration "$ITERATION")
  printf '%s\n' "$AUTHOR" | jq -e '.data.result.result == "complete" and (.data.result.commit | type == "string" and length > 0)' >/dev/null ||
    pause "Author needs attention in run $RUN_ID: $AUTHOR"
  COMMIT=$(printf '%s\n' "$AUTHOR" | jq -er '.data.result.commit')
  STEP=$(printf '%s\n' "$AUTHOR" | jq -er '.data.step_name')

  # Every changed-code attempt gets a new iteration. A retry at the same keys
  # can reuse successful quality, so never reuse those keys for a new fix.
  printf '%s\n' "$AUTHOR" | fivex phase finish --run "$RUN_ID" \
    --phase "$PHASE" --iteration "$ITERATION" --step "$STEP"

  # Resolve review paths from the template, rather than hardcoding old .5x paths.
  RENDERED=$(fivex template render reviewer-commit --run "$RUN_ID" \
    --var "phase_number=$PHASE" --var "commit_hash=$COMMIT" --new-session)
  REVIEW_PATH=$(printf '%s\n' "$RENDERED" | jq -er '.data.variables.review_path')
  REVIEW=$(fivex invoke reviewer reviewer-commit --run "$RUN_ID" \
    --var "phase_number=$PHASE" --var "commit_hash=$COMMIT" --new-session \
    --record --phase "$PHASE" --iteration "$ITERATION")

  # A reviewer should commit its narrative. Verify the actual mapped checkout,
  # and checkpoint the review file if the worker left it uncommitted.
  STATE=$(fivex run state --run "$RUN_ID")
  WORKTREE=$(printf '%s\n' "$STATE" | jq -r '.data.run.worktree_path // empty')
  if [[ -z "$WORKTREE" ]]; then
    WORKTREE=$(git -C "$(dirname "$PLAN")" rev-parse --show-toplevel)
  fi
  [[ -f "$REVIEW_PATH" ]] || pause "Reviewer did not write $REVIEW_PATH"
  if ! git -C "$WORKTREE" ls-files --error-unmatch -- "$REVIEW_PATH" >/dev/null 2>&1 ||
      [[ -n $(git -C "$WORKTREE" status --porcelain -- "$REVIEW_PATH") ]]; then
    fivex commit --run "$RUN_ID" -m "review: phase $PHASE" --files "$REVIEW_PATH"
  fi

  MODE=$(printf '%s\n' "$REVIEW" | jq -r '.data.pinned_mode // empty')
  ROUTE=$(printf '%s\n' "$REVIEW" | jq -r '.data.result.governance.route // empty')
  NEXT=$(printf '%s\n' "$REVIEW" | jq -r '.data.result.governance.nextAction // empty')
  if [[ "$MODE" == enforced ]]; then
    [[ "$NEXT" != plan_amendment ]] || pause "Run $RUN_ID requires a plan amendment."
    case "$ROUTE" in
      complete) APPROVED=true; break ;;
      author_revision) ;;
      *) pause "Run $RUN_ID requires workflow handoff: route=$ROUTE nextAction=$NEXT" ;;
    esac
  else
    # Advisory hypothetical routes do not grant final-correction shortcuts.
    READINESS=$(printf '%s\n' "$REVIEW" | jq -er '.data.result.readiness')
    if [[ "$READINESS" == ready ]]; then
      APPROVED=true
      break
    fi
    printf '%s\n' "$REVIEW" | jq -e '.data.result.items | length > 0 and all(.[]; .action == "auto_fix")' >/dev/null ||
      pause "Run $RUN_ID needs a human decision: $REVIEW"
  fi
  TEMPLATE=author-process-impl-review
done
[[ "$APPROVED" == true ]] || pause "Configured review limit reached for run $RUN_ID."

PHASES=$(fivex plan phases "$PLAN")
[[ $(printf '%s\n' "$PHASES" | jq -c '[.data.phases[].id]') == "$PHASE_IDS" ]] ||
  pause 'Plan phase identities changed during execution.'
printf '%s\n' "$PHASES" | jq -e --arg phase "$PHASE" \
  '.data.phases[] | select((.id | tostring) == $phase) | .done == true' >/dev/null ||
  pause "Phase $PHASE checklist is incomplete."

# The CLI enforces the durable implementation boundary as well as our checks.
fivex run record phase:complete --run "$RUN_ID" --phase "$PHASE" \
  --iteration "$ITERATION" --result "$(jq -nc --arg phase "$PHASE" '{phase:$phase}')"
if printf '%s\n' "$PHASES" | jq -e 'all(.data.phases[]; .done == true)' >/dev/null; then
  fivex run complete --run "$RUN_ID"
  FINISHED=true
else
  printf 'Phase %s reviewed. Run %s remains active for the next phase.\n' "$PHASE" "$RUN_ID"
fi

/** Offline protocol reference, shared by CLI help and validation diagnostics. */
export const CLOSURE_EVIDENCE_HELP = `New closure items require exactly one evidence path:
  introducedBy: {"commitRange":"<previous-review-sha>..<current-plan-sha>",
    "diffHunk":"@@ ... @@\\n context\\n-old\\n+new",
    "explanation":"How this revision introduced the failure"}
  Use literal commit hashes (unique prefixes accepted), not HEAD or branch names.
  Copy one complete hunk from the plan-only git diff, including its @@ header,
  context and changed lines; exclude diff --git/---/+++ file headers. Encode
  newlines as \\n in JSON. Use the range and git diff command in the rendered prompt.
  OR lateDiscovery: "critical_safety", lateDiscoveryEvidence: "Concrete security,
  data-loss, or correctness threat". Use scopeClass acceptance_required or
  risk_reduction and action human_required. This is for critical pre-existing
  threats, not ordinary missed issues; put those in nonblocking follow-ups.
  Re-raising an accepted-risk finding instead requires its stable id,
  priorDecisionId and material newEvidence; preserve its fingerprinted scope.
  Inspect the complete schema offline: 5x protocol schema reviewer`;

export const REVIEWER_PROTOCOL_HELP = `
ReviewerVerdict fields:
  readiness: ready | ready_with_corrections | not_ready; items: array; summary: string.
  --item accepts id, title, action (auto_fix|human_required), reason, priority
  (P0|P1|P2). id is generated if omitted by emit; retain stable IDs on re-review.
  Active-budget items also need scopeClass (acceptance_required|risk_reduction|polish),
  effortDelta (integer >= 0), architectureDelta (0, +/-1, +/-2, +/-3, +/-5),
  estimateConfidence (low|medium|high), failure, and lowestCostCorrection.
  coupling (intrinsic|adjacent|unrelated) is required for negative architectureDelta.
  requiresReviewerVerification is an optional boolean.
  Implementation-review items use the admitted phase's scopeClass domain.
  implementation_defect requires nonempty unique planWorkItemIds linking approved
  work. plan_defect requires planImpact: {kind, locations: [{heading, staleText}]};
  text_only locations must be nonempty, while design and budget route to a human.
  boundaryChanges lists explicit boundary labels; omit it when impact is unknown.
  mechanicalExplanation describes the mechanical correction. Implementation
  architectureDelta accepts signed integers rather than plan-review magnitudes.
  Implementation introducedBy evidence includes the diff --git line plus the
  complete file-qualified @@ hunk from the supplied code commitRange.
  Optional creditClaim: {creditClaimId, targetPhase, minimalAlternativeEffortDelta,
  minimalAlternativeArchitectureDelta, before, after}; effort alternatives are
  0,1,2,3,5,8. Use this only for a finding's own claim, not an author-ledger DCn.
  --baseline-assessment: {independentEffortEstimate: integer >= 0,
  confidence: low|medium|high, reason: string}; required on the initial active
  review, omitted on closure reviews.
  --credit-assessment: {creditClaimId, eligibility: eligible|ineligible,
  coupling: intrinsic|adjacent|unrelated, reason}; assess all author claims initially,
  then only new/changed claims. CLI-derived totals and governance are prohibited.
  --prior-finding: {id, status: addressed|partially_addressed|still_open}; emit
  exactly the required IDs from governance context. Addressed IDs leave items;
  partial/open IDs remain once with the same identity and remaining effort.
  --credit-realization: {creditClaimId, realization, realizedArchitectureDelta,
  evidence}; report implementation credit realization with nonempty evidence.

${CLOSURE_EVIDENCE_HELP}

Closure example (replace hashes and hunk with the actual plan diff):
  $ 5x protocol emit reviewer --ready --prior-finding '{"id":"R1","status":"addressed"}' --item '{"id":"R11","title":"Restore validation","action":"auto_fix","reason":"Revision removed validation","scopeClass":"acceptance_required","effortDelta":1,"architectureDelta":0,"estimateConfidence":"high","failure":"Invalid input reaches storage","lowestCostCorrection":"Restore the validation step","introducedBy":{"commitRange":"abc1234..def5678","diffHunk":"@@ -1 +1 @@\\n-Validate then store\\n+Store directly","explanation":"The revised step removes input validation"}}'

Malformed active Delivery Budgets return PLAN_REPAIR_REQUIRED before review with
reviewRoute author_revision and the underlying diagnostic. Have the author repair
and commit the plan, then render/invoke the same review again. This gate records no
review and does not reset the baseline. If a plan changes during review, validate
--record returns the same repair gate; re-review the repaired plan before recording.
`;

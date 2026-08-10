{
  "verdict": "rejected",
  "summary": "Firepoints and tests mostly pass, but freshness suppression does not apply to harness list as required.",
  "issues": [
    {
      "severity": "major",
      "description": "`harness.freshnessWarnings = \"off\"` is required to silence all Phase 5 firepoints, but list always runs the check and includes `freshness` in text/JSON for installed scopes. Thus a suppressed stale install still emits freshness output via `5x harness list`. Honor the suppression setting before collecting/attaching list freshness and add coverage.",
      "location": "src/commands/harness.handler.ts:401-455"
    }
  ]
}

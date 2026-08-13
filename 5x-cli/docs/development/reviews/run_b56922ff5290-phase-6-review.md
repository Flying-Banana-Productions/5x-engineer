{
  "verdict": "rejected",
  "summary": "Sync works for covered flows, but --check misreports adoption/unverified writes.",
  "issues": [
    {
      "severity": "major",
      "description": "For a manifest-less (or hashless/unverified) installed scope, Tier 2 returns no assetDeltas. The --check branch derives changed only from those deltas, so it reports changed: [] even though a real sync force-overwrites every managed asset and adopts a baseline. This violates --check's promise to report what sync would change and hides destructive adoption from users.",
      "location": "src/commands/harness.handler.ts:743-750"
    }
  ]
}

{"verdict":"approved","summary":"Re-review: --check now projects rendered write sets and managed-agent removals; adoption and removal coverage passes. Full concurrent suite passes (2440 pass, 8 skipped).","issues":[]}

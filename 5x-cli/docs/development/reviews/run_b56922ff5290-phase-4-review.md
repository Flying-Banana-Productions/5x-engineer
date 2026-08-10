{
  "verdict": "rejected",
  "summary": "Freshness logic and targeted tests pass, but malformed manifests can be accepted as fresh, violating the required fail-closed semantics.",
  "issues": [
    {
      "severity": "major",
      "description": "The manifest shape guard only verifies that `inputs` and `installedFrom` are objects, not their required fields/types. For example, deleting `inputs.plugin` from an otherwise valid manifest is accepted; comparison treats it as `{}`, while the recorded hash still matches the normalized current inputs, producing `fresh`. A committed/hand-edited incomplete manifest must be `manifest-unreadable`/`unknown`, never fresh. Validate the complete nested manifest shape (including input fields/plugin values and provenance fields) and add corruption regression coverage.",
      "location": "src/harnesses/manifest.ts:1121-1148"
    }
  ]
}

# Review: Phase 3 manifest lifecycle

**Commit:** `e61ad0511f14afa35bce1183e8118dcfa05bd177`  
**Scope:** Phase 3 in `docs/development/plans/201-harness-freshness-plan.md`

## Verdict

Rejected. Baseline retention, config provenance, inventory hashing, uninstall ordering, output, and targeted tests are otherwise implemented and pass. Manifest inventory accepts untrusted rendered and install-summary paths without proving they remain under `rootDir`; traversal paths can make it hash and record files outside the install root. This violates the root-relative manifest safety contract.

## Blocking issue

- **Major — path traversal in inventory collection:** `collectInstalledAssets()` accepts `RenderedAsset.path`, prior manifest paths, and summary entries verbatim. `joinManifestPath(rootDir, relPath)` normalizes `../` and can read outside `rootDir`; `toManifestPath()` can also retain an escaping relative path. `assertAssetPathsUnderRoot()` validates only asset directories, not declared asset paths. Reject absolute/traversal paths (or prove every resolved asset path remains under `rootDir`) before reading/recording, including summary and prior-manifest entries. Add traversal tests. `src/harnesses/manifest.ts:442-471`

Validation: `bun test test/unit/harnesses/manifest.test.ts test/unit/commands/harness.test.ts test/integration/commands/harness-manifest.test.ts` (127 pass); `bun run typecheck`; `bun run lint`.

<!-- 5x:verdict
protocolVersion: 1
readiness: not_ready
reviewPath: docs/development/reviews/run_b56922ff5290-phase-3-review.md
items:
  - severity: major
    description: Manifest inventory paths are not constrained to the install root.
    location: src/harnesses/manifest.ts:442-471
-->

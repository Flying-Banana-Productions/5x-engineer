# Review: 025-commit-tracking plan v1.4

## Verdict

Not ready.

## Blocking issues

### 1. Design decision still says the orchestrator calls `5x commit`

The revised plan pivots to author-owned commits, but the design decision at
`docs/development/025-commit-tracking.plan.md:47` still says "The orchestrator
reaches for this command directly." That directly contradicts the v1.4 revision
history, overview, and later Phase 5 statement that no orchestrator-level
commit calls are added. The plan needs one consistent ownership model before
execution.

### 2. Phase 4 does not actually update author templates to instruct `5x commit`

Phase 4 says to replace an existing "git add / git commit" block in the author
templates, but those templates do not currently contain such a block. Today
they only say to commit before finishing and then run `5x protocol emit author
--complete --commit <hash>`. As written, this task can be implemented without
ever adding the explicit `5x commit --run {{run_id}} ...` instruction the v1.4
pivot depends on, leaving authors free to keep using raw git and bypass commit
tracking. The plan should specify exactly where the completion instructions in
each author template must change, including how the hash from `5x commit` is
captured and fed into `5x protocol emit author`.

### 3. No test coverage is planned for the new `run_id` template variable

`run_id` is one of the headline changes in v1.4, but the planned test work only
covers commit command behavior and review-path re-rooting. There is no unit or
integration test that renders a template with `--run` and verifies that
`{{run_id}}` is populated, exposed in resolved variables, and usable by updated
templates. That leaves the central prompt-plumbing change unverified.

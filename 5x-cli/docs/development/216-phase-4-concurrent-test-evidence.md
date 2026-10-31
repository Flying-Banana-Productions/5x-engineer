# Plan 216 phase 4 concurrent test timeouts

**Run:** `run_e9f7394d17bc`
**Phase:** 4 quality remediation. The executing plan stays schema 0. This note is not a plan edit.
**Product code:** unchanged.

## What the gate actually did

`5x quality run` resolves this run to the linked worktree and runs the gates in `5x-cli` (`Quality gates executing in: …/216-plan-schema-contracts-and-migration-plan-768a25/5x-cli`). The runner is `runSingleCommand`: `sh -c` with stdout and stderr piped, stdin left at the spawn default, and `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` removed from the copied environment. The orchestrator process on this machine had the same `TMPDIR` as the shell and no `GIT_DIR`.

Commit `d9566b6c` did not stabilize that gate. The immediate rerun wrote `.5x/logs/run_e9f7394d17bc/quality-phase0-attempt1-bun-run-test.log`:

- `bun test --concurrent --dots --timeout 15000`
- 4026 pass, 2 fail, 15918 expect() calls, 259 files, 218.47s
- `plan-diff.test.ts` — accepts a pre-artifact end commit with an equivalent plan patch and exact hunk — 15000.57ms
- `protocol-validate.test.ts` — a paired collision is an error envelope before success — 15000.17ms

The log is 5164 bytes. That is under a pipe buffer, the suite printed its summary, and the runner's 300s command timeout did not fire. Capture did not stall `bun test`. The two failures are bun's per-test kill. Lint had already passed. This is the same machine as the direct runs that passed; the failed gate was slower (218s versus about 190s), not a different host.

## Why those two tests hit 15s

`--concurrent` runs every test in a file on one thread. The timer starts when the test starts and keeps running while a sibling blocks that thread. `describe.serial` does not change this under `--concurrent` on bun 1.4.4 (both tests in the block started together). `test.serial` does: it runs after the file's concurrent tests, one at a time, and a 300ms serial test still passed when a sibling slept 700ms.

`d9566b6c` removed per-test `git init`, but the plan-diff file still ran five histories at once, and the protocol recording tests still awaited `prepareImplementationReviewContext` (a chain of `git status` / `diff` / `merge-base`) while other tests in that file copied fixtures. The pre-artifact test and the paired-collision test are the ones the rerun killed. Assertions are unchanged.

Nested workers are the default `--parallel` width (8), the same for a direct `bun run test` and for the gate. Git fixture output is far below the pipe size, and those spawns already pass `stdin: "ignore"` and read both pipes. The suite-level capture was not the stall.

## Mitigation

`test.serial` on all five plan-diff tests, and on the four protocol recording tests that build a review context. The suite timeout stays 15000ms. No test was disabled.

## Orchestrated gate after the change

`5x quality run --run run_e9f7394d17bc` with no `--record`, from this worktree. Both runs: lint clean (463 files), 4028 pass, 0 fail, 15926 expect() calls, 259 files.

| Run | Test wall | Process real | user | sys |
| --- | --- | --- | --- | --- |
| Gate after `d9566b6c` | 218.47s | (not recorded) | | |
| After `test.serial`, first | 192.29s | 192.99s | 303.60s | 242.13s |
| After `test.serial`, second | 190.73s | 191.49s | 304.11s | 241.35s |

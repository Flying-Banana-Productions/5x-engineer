# Plan 216 phase 4 concurrent test timeouts

**Run:** `run_e9f7394d17bc`
**Phase:** 4 quality remediation. The executing plan stays schema 0. This note is not a plan edit.
**Product code:** unchanged.

## Root cause

`bun test --concurrent` runs the tests in one file on a single thread. `--max-concurrency` defaults to 20, and `--parallel` defaults to the CPU count (8 on this machine). `Bun.spawnSync` blocks that thread. A test's 15s budget is wall-clock from the moment it starts, including time it spends waiting behind a sibling's git process. Async git in product code cannot resume during that block.

Two fixtures made that budget depend on how busy process startup was:

- `test/integration/plan-diff.test.ts` built each history with one synchronous git process per `init`, `add`, `commit`, and `rev-parse`. Five concurrent tests serialized about 50 of those calls, then `buildPlanReviewDiffContext` awaited more git. The equivalence test already carried a 60s timeout for that reason. The pre-artifact test stayed at 15s. Under full-suite startup delay, about 300ms per git call is enough for 50 calls to miss 15s.
- `test/unit/commands/protocol-validate.test.ts` has 95 tests. Twenty-one call `setupProjectDir`, which ran five synchronous git commands and did not pass `cleanGitEnv()`. With the concurrency cap, a batch of those setups shares the thread with "both entry points persist the same observation and durable authorization", which is waiting on `protocolValidate` and `invokeAgent`. The same test was killed at 5000ms in phase 0 and at 15000ms by the phase 4 gate.

The phase 4 gate recorded two consecutive failures, both at 15000ms, on those two tests, after lint, typecheck, and the focused asset suite (34 pass) had succeeded. A quiet reproduction on this machine passed (below), so the failure is load margin, not a wrong assertion.

## What changed

`test/helpers/git-fixture.ts` keeps git off the per-test critical path:

- `copyInitializedRepo` copies one shared `git init -b main` repo with the test author. Later tests do not spawn `git init` or two `git config` processes.
- `commitAll` / `commitAllSync` run `git add -A` and `git commit` in one process. Concurrent tests use the async form.
- `importCommitSequence` builds a whole history with one async `git fast-import`, then one async `git reset --hard`. Plan-diff still asserts rename detection, equivalent endpoints, exact hunk text, and binary rejection.
- `copyCommittedProject` copies a committed tree and, for the protocol fixture, a migrated `.5x/5x.db`. `readHead` reads the ref file. The protocol recording test no longer spawns git for setup. The two amendment tests each use one async `commitAll`.
- The repeated init/config/add/commit blocks in the other unit and integration fixtures now call those helpers. Every remaining helper spawn passes `cleanGitEnv()`.

The suite timeout stayed 15000ms. The plan-diff equivalence test's special 60s timeout is back to 15000ms. The protocol recording test still calls the handlers directly, so it stays in the unit file; the subprocess setup is what moved. Plan-diff was already an integration test.

## Timings

Command, from `5x-cli`: `bun run test` (`bun test --concurrent --dots --timeout 15000`).

| Run | Result | Wall | user | sys |
| --- | --- | --- | --- | --- |
| Before, this machine | 4028 pass, 0 fail, 15926 assertions, 259 files | 199.49s | 302.03s | 239.09s |
| After, first | 4028 pass, 0 fail, 15926 assertions, 259 files | 189.84s | 300.11s | 239.74s |
| After, second | 4028 pass, 0 fail, 15926 assertions, 259 files | 189.07s | 300.17s | 239.22s |

The before run passed here. The gate's two failures are the same command on a busier machine. Wall time dropped about 10s with almost the same CPU total: less time is spent blocked behind `spawnSync`, so overlapping tests finish inside the 15s budget instead of adding their git calls together.

Isolated files, same flags:

| Scope | Before | After |
| --- | --- | --- |
| `plan-diff.test.ts` + `protocol-validate.test.ts` (100 tests) | 5.67s | 3.70s |
| `plan-diff.test.ts` alone (5 tests) | included above | 228ms |

Also, after the fixture change: `bun run lint` clean (Biome 2.5.15, 463 files), `bun run typecheck` clean, focused asset suite `bun test --concurrent --timeout 15000 test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts` 34 pass, 0 fail, 7.88s.

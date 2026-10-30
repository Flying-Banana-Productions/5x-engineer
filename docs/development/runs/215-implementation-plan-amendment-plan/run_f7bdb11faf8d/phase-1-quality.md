# Phase 1 quality diagnosis

Recorded for run `run_f7bdb11faf8d` on October 19, 2026. Phase 1 product commit `d9e4845`. This note does not change the plan.

## What failed

Two `bun run test` quality attempts were killed at the runner's 300s command limit. Both failed `watchFirstLog` in `test/integration/commands/run-control-plane-bootstrap.test.ts` with `JSON Parse error: Unexpected EOF` after about 12s. One attempt also reported `test/unit/commands/protocol-validate.test.ts` timing out at 5000ms. Lint was clean. The saved log is `quality-phase0-attempt1-bun-run-test.log` (the runner labels the phase from the attempt slot).

Phase 0's same gate passed in 278s and 214s. Phase 1 did not change the watch helper or `protocol-validate.test.ts`.

## Watch empty stdout

`watchFirstLog` armed `SIGINT` 10s after spawn. The failure path is `wroteLog === true`, exit code 0, stderr without `[watch]`, and empty stdout. That is a clean watch shutdown before any NDJSON line was written.

`NdjsonTailer` cleanup marked the iterator done without reading bytes already on disk, and a done wakeup dropped pending lines. A direct probe wrote `agent-001.ndjson` and aborted before the next poll: the iterator returned `{done: true}` and the line was lost. Under `bun test --concurrent`, Bun startup contends for CPU (the same constraint documented on `run5xWatch` in `run-watch.test.ts`). The 10s kill landed after `mkdir` of the log directory and before that poll, so the assertion parsed an empty string.

Isolated, the bootstrap file passed in 18s. Six parallel copies passed. In a full-suite JUnit run the same cases passed in 12–14s after the fix, instead of exiting empty.

The fix drains on-disk lines during abort and still yields them, and the helper stops when the record appears. If the line is on disk but not yet polled, it sends SIGINT after a 2s observe window so the drain runs. A 25s cap only covers a watch that never creates the directory. The JSON assertion is unchanged.

`run watch` still writes through `process.stdout.write`. `writeSync` bypassed the stdout patch in `watch-error-harness.ts` and the streaming-error test never finished.

## 5000ms test timeouts

Bun 1.4.2 ignores `[test] timeout` in `bunfig.toml` (oven-sh/bun#7789). The runner default stays 5000ms. An in-repo 6s test died at 5000ms with `timeout = 15000` in bunfig. A test with an explicit `{ timeout: 20000 }` still slept 16s under `--timeout 15000`, so the flag is the default and a per-test timeout can be higher.

That is why one quality attempt killed `protocol-validate.test.ts` at 5000ms, and why a full suite here killed `doctor records check` at 5000ms before the flag existed. Both files have no per-test timeout. The same doctor file finished in 4.7s alone, and it passed in the full suite once the script passed `--timeout 15000`. `package.json`'s `test` script now passes that flag. The bunfig key is commented so it is not mistaken for the control. `AGENTS.md` matches.

`protocol and invoke implementation recording > both entry points persist the same observation and durable authorization` is the 5000ms case named by an earlier review of this file, and it also died at 15000ms in one hot full suite here. Alone it finishes in about 0.6s. The overage is concurrency, not a slower assertion. It now has `{ timeout: 30_000 }`. The assertions are unchanged.

Later full-suite runs on a hot machine also hit explicit 15s and 30s budgets (`progress-resolution`, `implementation-completion`, doctor again at 15s). Those budgets were already on the tests. They did not fail in the suite that only failed the new tailer regression, and they are not Phase 1 behavior changes.

## Suite duration

A full `bun test --concurrent --dots` before the timeout flag: 3928 pass, 1 fail (doctor at 5000ms), 297.38s. With `--timeout 15000` and the first tailer regression: 3930 pass, 1 fail, 301.29s. JUnit on a loaded machine: 3930 pass, 1 pre-existing 15s timeout, 393s; summed test time 2428s. The 300s quality kill is the suite sitting on the runner default, made worse by the orchestrator, not a hung watch. Watch no longer burns the 10s kill on an empty read.

## Checks

- `bun test --timeout 15000 test/unit/utils/ndjson-tailer.test.ts` five concurrent runs: 14 pass each, including abort-before-poll.
- `bun test --timeout 15000 test/unit/utils/ndjson-tailer.test.ts test/integration/commands/run-watch.test.ts test/integration/commands/run-control-plane-bootstrap.test.ts`: 36 pass.
- `bun run typecheck` and `bun run lint`: clean.

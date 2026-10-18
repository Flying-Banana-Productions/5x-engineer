# Automation guide for scripts and assistants

[README](../README.md) · [CLI reference](cli-reference.md) · [LLM index](../llms.txt)

This is an operational reference for the implemented 2.0.0 development line,
currently unreleased. Use it with the installed CLI's help and workflow skills.
The numbered design documents are historical/proposed architecture, not a
substitute for checking the executable's capabilities.

## Establish context

Before executing a workflow:

```bash
5x --version
5x config show --json
5x harness list --json
5x template list --json
```

For a monorepo, use `config show --context <plan-directory>` to inspect the
configuration that run execution will use. The config envelope contains
`data.files` and `data.entries` (key/value/default/local metadata), not a nested
`data.author` configuration object. `config show --key <key> --json` returns one
entry whose resolved value is `data.value`.

Load the installed `5x` foundation with the applicable `5x-plan`,
`5x-plan-review`, or `5x-phase-execution` skill. Use `5x-config` for setup and
`5x-windows` on Windows/PowerShell. Keep the multi-step workflow in the
orchestrator; delegate bounded author/reviewer tasks to workers.

Read each role's `delegationMode` before delegation. Native harnesses support
mixed roles; universal uses invoke. File-existence checks alone do not choose
the execution path. After model/delegation or CLI changes, synchronize installed
assets rather than assuming their rendered settings changed automatically.

### Sources of authority

- **Installed CLI/help/schema:** available commands and accepted structured data.
- **Resolved config:** paths, providers, models, delegation, retry/step limits.
- **Effective installed skills:** the workflow for that harness and role mode.
- **Rendered runtime context and durable run state:** bindings, exact review
  ranges, admitted findings, prior outcomes, decisions, claims, and routes.

Static documentation explains how to use these surfaces. Never manufacture
runtime identities or approval evidence from an example, a current HEAD, or
editable plan/review prose. Treat old compatibility instructions as applicable
only to a run actually admitted to that path.

## Initialize or resume

The plan path is an implementation-plan output path under `paths.plans`. It may
not exist yet during plan generation. It is not the requirements document.

```bash
INIT=$(5x run init --plan "$PLAN" --worktree --json)
RUN_ID=$(printf '%s\n' "$INIT" | jq -er '.data.run_id')
export FIVEX_RUN="$RUN_ID"
printf '%s\n' "$INIT" | jq '.data | {warnings, harness_freshness}'
5x run state --run "$RUN_ID" --json
```

Check the init command's exit status before using the envelope. Show nonempty
`warnings` / `harness_freshness` to the operator and preserve stderr warnings.
Honor an explicit `harness.freshnessWarnings = "off"` setting. Synchronization
is the remedy; plain install preserves existing agents.

`run init` is idempotent for an active plan run. When resuming, inspect history
and governance before delegating again. Do not reset local counters and replay
step identities blindly. Permit sufficient time for worktree creation/hooks.

Identity precedence is `--run` → `FIVEX_RUN` → unique linked-worktree mapping →
compatible state-directory `current-run` → invoke/record pipe fallback. Invalid
or ambiguous earlier signals error. Queue workers, invocation-registry calls,
and explicit-ID governance commands must receive their required IDs. Use
explicit `--run` in multi-run scripts.

## Delegate and record

### Native roles

Render before delegating so the worker receives the complete effective prompt:

```bash
RENDERED=$(5x template render author-next-phase --run "$RUN_ID" \
  --var "phase_number=$PHASE" --json)
PROMPT=$(printf '%s\n' "$RENDERED" | jq -er '.data.prompt')
STEP=$(printf '%s\n' "$RENDERED" | jq -er '.data.step_name')
```

Use the host's native task tool with the appropriate installed author/reviewer
profile and that prompt. This step is a host API call, not executable shell
syntax. Save the returned structured author JSON as `author-result.json`, then:

```bash
5x phase finish --run "$RUN_ID" --phase "$PHASE" --iteration "$ITERATION" \
  --step "$STEP" --input author-result.json --json
```

For reviewer results, use `protocol validate reviewer --record` with the rendered
step, phase, iteration, and **`--review-context <id>` when render supplies one**.
Raw structured JSON is preferred; validate also accepts a single fenced JSON
block and invoke envelopes. `protocol emit` constructs canonical raw results;
`protocol schema author|reviewer` and `protocol emit reviewer --help` work offline.

### Invoke roles

```bash
AUTHOR=$(5x invoke author author-next-phase --run "$RUN_ID" \
  --var "phase_number=$PHASE" --record --phase "$PHASE" \
  --iteration "$ITERATION" --json)
```

Invoke renders runtime context, executes the provider, and validates output.
`--record` records under the template's `step_name`; `--record-step` overrides
it. Check both process exit status and structured result. Preserve failure
details such as session ID and log path for recovery.

Authors return `result: complete | needs_human | failed`. A complete
implementation result requires a commit; do not invent one or silently waive
validation. Reviewers return `readiness: ready | ready_with_corrections |
not_ready`, plus applicable evidence. A schema-valid result alone is not
authorization to complete an enforced phase.

Template variables such as plan/review/template paths resolve from run context.
Avoid overriding `plan_path` when `--run` already identifies it. Render/invoke
share runtime-appended implementation context. Follow the effective working
directory in that context, including mapped worktrees.

## Continuation and retries

- Invoke continuity uses provider `session_id` with `--session`.
- Native continuity uses the host task ID/resume mechanism; render uses
  `--continue-native` to select an available continued prompt.
- Never pass a native task ID as a provider session ID.
- `--new-session` selects a fresh prompt/session path. It does not clear durable
  findings, a binding, or a runtime closure-review requirement.
- Read the runtime review kind even on an initial template: a fresh session can
  still require closure evidence and every prior-finding outcome.

Records use first-write-wins step identities (run, step, phase, iteration).
An identical retry can return `recorded: false`; that is successful idempotency.
A changed result/correction must use a new iteration, not overwrite a record.
`phase finish` skips successful substeps on retry at the same keys. **New code
needs new attempt keys**, so a cached successful quality run is not reused for
changed code. Read configured limits instead of hardcoding review/retry budgets.

## Quality and completion

`phase finish` composes quality → author validation/recording → checklist. It
does not run the reviewer or record final phase approval. Inspect substep status
and errors; skipped quality means checks did not run. It can consume a raw
author result or an invoke envelope on stdin.

After any author correction, run quality again, then re-enter review unless the
enforced runtime route explicitly authorizes the special final-correction path.
Use the author's implementation commit, not a later review-document commit, when
supplying a commit variable. A bound review's recorded range remains authoritative.

Before `phase:complete`:

1. `plan phases` must report that phase `done: true` and unchanged phase identity.
2. Required review/quality evidence must be recorded.
3. For enforced implementation, durable governance must permit advancement,
   including due-claim reconciliation and no blocking gate.

Then record completion using real variables, not literal shell placeholders:

```bash
5x run record phase:complete --run "$RUN_ID" --phase "$PHASE" \
  --iteration "$ITERATION" \
  --result "$(jq -nc --arg phase "$PHASE" '{phase:$phase}')" --json
```

Between phases, follow the installed skill's human handoff. `run complete` is for
the finished workflow, not merely one successful author call or one finished
phase of a multi-phase plan. A completed plan-review run is a distinct workflow
outcome from completed implementation.

## Review governance

### Plan review

The plan's Delivery Budget lists stable scored work items and any concrete debt
claims. The CLI derives totals, immutable baselines, forecasts, and mode-pinned
governance. Initial review is exhaustive; subsequent closure review checks the
admitted findings and required evidence. Markdown is the audit narrative;
structured output and durable context govern routing.

In enforced mode, consume the CLI-owned route rather than recomputing it from
readiness, prose, or iteration counts. Advisory preserves ordinary review/fix
routing and exposes diagnostics; older compatibility runs do not gain a baseline
just because the current config defaults to advisory.

### Implementation binding and exact ranges

Before the first author delegation, render/invoke performs admission and captures
pre-author HEAD for applicable budgeted runs. Retain the envelope's `binding_id`,
`source_run_id`, `pinned_mode`, and `pre_author_commit`; do not recapture the start
after work is done.

`IMPLEMENTATION_APPROVAL_REQUIRED` means admission could not choose the required
approved source. Ask the operator to select it, then:

```bash
5x review implementation bind --run "$RUN_ID" --source-run <approved-review-run>
```

A successful unbound compatibility admission is different from an admission
error. Do not treat the latter as permission to continue without governance.
Advisory bound runs still enforce source binding and plan-drift validation.

Review context supplies the exact range, work-item links, prior finding outcomes,
due claims, and decisions. Reviewers classify findings by source of correction
(implementation defect, plan defect, scope expansion, pre-existing issue) under
that supplied contract. Promised/waived credit is not physically realized credit;
use runtime reconciliation and telemetry rather than hand-calculating it.

### Gates and corrections

```bash
5x review gate show --run "$RUN_ID" --phase "$PHASE" --json
```

Present causes, `allowedChoices`, and `requiredFieldsByChoice` to the human.
Submit their actual selection with `review decide --gate <id>` and the required
fields (or `--input-json`). Decisions are append-only and atomically accepted;
stale/losing submissions must be re-inspected, not blindly retried as approvals.
Generic prompt answers or `human:gate` records do not resolve governance gates.

For enforced implementation, the recorded result's `governance.route` and
`nextAction` determine the branch:

- `complete`: verify the phase boundary.
- `author_revision`: fix admitted findings, run quality, and review again.
- `final_corrections`: perform only the eligible correction, then use
  `review corrections finish --run … --phase … --review … --commit …`. That
  command runs fresh full quality; an ordinary cached quality result is no proof.
- `human_gate` or `nextAction: plan_amendment`: stop for the relevant decision or
  amendment workflow. Permission to revise a plan is not approval to implement
  new scope.

Advisory hypothetical routes do not authorize the no-review final-correction
shortcut or introduce debt-based completion blocks. Keep ordinary reviewer
re-entry. No-binding/off compatibility uses the legacy readiness contract.

The current `review implementation recover-plan` supports only a narrow reviewed
amendment at an unfinished frontier. It requires a durable amendment
authorization, completed plan-review snapshot, recorded author commit, and
operator scope/preserved-phase attestations. Inspect `--help`, preview with
`--dry-run`, and follow installed skill recovery. It preserves the original
binding/baseline and requires fresh implementation review. Never fabricate
attestations, rebind, or edit records to bypass rejection. General semantic
amendment registration remains pending.

## Human handoff and recovery

Prefer the host's question/chat UI for human input. Use `prompt` for terminal or
scripted interactions; its defaults/timeouts are documented in the
[CLI reference](cli-reference.md#prompt-behavior). Checkpoint before every wait,
escalation, or exit that leaves the run active:

```bash
5x commit --run "$RUN_ID" --no-record -m "5x: checkpoint run records"
```

This commits only active-run records and succeeds as a no-op if clean. It does
not commit arbitrary incomplete code. `run complete` seals records itself.

Use `doctor`, targeted lock recovery, run state, and log paths to diagnose
failures. Resume from durable route/evidence, not an assistant's reconstructed
memory. Show both the failure and the next actionable command to the operator.

## Shell example

[`examples/author-review-loop.sh`](../examples/author-review-loop.sh) demonstrates
a bounded invoke-only implementation loop for **one phase of a fresh execution
run**. It uses configured limits, runs quality after every correction, and
checkpoints on handoff. It supports ordinary advisory/compatibility routing and
enforced `author_revision`/`complete`; specialized correction, amendment, and
human-gate routes hand off to the installed phase-execution skill. It leaves the
run active when more phases remain and refuses to replay an existing active run.

Use the process skill for full workflow orchestration and recovery. The example
requires Bash, `jq`, configured invoke roles/providers, and an approved plan. It
does not change review policy or provider settings for you.

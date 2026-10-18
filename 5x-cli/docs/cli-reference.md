# CLI reference

[README](../README.md) · [Automation](automation.md) · [Operations](operations.md)

This map covers the implemented 2.0.0 development line. Use `5x --version` and
`5x <command> --help` for the exact flags supported by your installed release.
Angle-bracket arguments below are placeholders; replace them before running.

## Command map

| Task | Commands |
| --- | --- |
| Initialize | `init [--install-templates] [--force]`, `init --sub-project-path <dir>` |
| Inspect/edit settings | `config show`, `config set <key> <value>`, `config unset <key>`, `config add <key> <value>`, `config remove <key> <value>` |
| Manage integrations | `harness install <name> --scope project\|user`, `harness list`, `harness sync [name] [--check]`, `harness uninstall <name>` |
| Migrate project assets | `upgrade [--sync\|--no-sync] [--force]` |
| Start/resume | `run init --plan <path> [--worktree [<path>]] [--allow-dirty]` |
| Inspect runs | `run state [--run <id>\|--plan <path>]`, `run list`, `run watch` |
| Record results | `run record [step] [--run <id>] [--result <json>] [--phase <p>] [--iteration <n>]` |
| End/reopen/repair association | `run complete [--status aborted]`, `run reopen`, `run relink` |
| Commit/checkpoint | `commit -m <message> --files <paths...>`, `commit -m <message> --all-files`, `commit --no-record -m <message>` |
| Delegate through a provider | `invoke author <template>`, `invoke reviewer <template>` |
| Inspect/cancel invocation | `invoke status --run <id>`, `invoke status --id <uuid>`, `invoke cancel <uuid>` |
| Inspect/render prompts | `template list`, `template describe <name>`, `template render <name>` |
| Construct/validate results | `protocol emit author\|reviewer`, `protocol validate author\|reviewer`, `protocol schema author\|reviewer` |
| Run checks | `quality run [--record]` |
| Finish author iteration | `phase finish --phase <p> --iteration <n> --step <name> [--input <file>]` |
| Inspect/archive plans | `plan list`, `plan phases <path>`, `plan archive [path] [--dry-run]` |
| Inspect changes | `diff [--run <id>] [--since <ref>] [--stat]` |
| Human input | `prompt choose <message> --options a,b,c`, `prompt confirm <message>`, `prompt input <message>` |
| Review governance | `review gate show`, `review decide --gate <id> …` |
| Select plan approval | `review implementation bind --run <id> --source-run <id>` |
| Narrow amendment recovery | `review implementation recover-plan --help` |
| Verify eligible correction | `review corrections finish --run <id> --phase <p> --review <observation-id> --commit <sha>` |
| Manage worktrees | `worktree create`, `worktree attach`, `worktree detach`, `worktree remove`, `worktree list` |
| Diagnose/recover | `doctor [--fix]`, `lock list`, `unlock <plan> [--force]` |
| Rebuild/export history | `records index [--plan <slug>]`, `records backfill [--dry-run] [--target <branch>]` |

### Common options

- `--run <id>` explicitly selects a run. Most run-scoped commands also support
  [ambient identity](operations.md#select-a-run); explicit-ID exceptions are
  documented in command help.
- `--record` on invoke/quality/validate records results. `--record-step` overrides
  the step name on invoke/quality; validate uses `--step`.
- `--phase` and `--iteration` identify recorded attempts. Phase finish requires
  both, plus `--step`; these are retry keys, not inferred counters.
- `--var key=value` is repeatable on render/invoke. Use `@./file` or
  `@/absolute/path` to read a value from a file, and `@-` for stdin. A bare
  `@username` is literal, not a file reference. Only one variable can consume stdin.
- `--session`, `--new-session`, and native render's `--continue-native` control
  continuation; see [automation](automation.md#continuation-and-retries).

## Output contract

Most commands return an envelope:

```json
{"ok":true,"data":{"run_id":"run_example"}}
```

Errors normally use:

```json
{"ok":false,"error":{"code":"RUN_NOT_FOUND","message":"…","detail":{"remediation":"…"}}}
```

`detail` is optional. Error codes are more precise than numeric exit categories.
Always check the process exit status as well as the envelope; an invoke can emit
its result and subsequently fail recording, reporting that failure on stderr.
Quality result consumers must also inspect `data.passed` / `data.skipped`.

### Human-readable output

```bash
5x plan list --text
5x run state --json
```

Precedence: `--text`/`--json` > `FIVEX_OUTPUT_FORMAT=text|json` > JSON default.
JSON is pretty-printed on a TTY and compact when piped; `--pretty`/`--no-pretty`
override formatting. Automation should request `--json` explicitly rather than
inherit a user's text preference.

### Current exceptions

| Surface | Successful stdout |
| --- | --- |
| `init`, `upgrade`, `harness install` | Text, even when `--json` is requested |
| `run watch` | NDJSON stream, or text with `--human-readable` |
| `protocol emit author/reviewer` | Raw canonical result JSON, not an envelope |
| `protocol schema author/reviewer` | Raw JSON Schema |
| `--help`, `--version` | CLI help/version text |

`run watch` errors before streaming can still be envelopes. Command-line usage
errors can be parser text on stderr. Output normalization in design documents is
pending, not the current contract. Provider progress and warnings use stderr;
do not suppress them merely to parse stdout.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Command succeeded; inspect result fields for workflow outcome |
| 1 | General/validation error, quality composite failure, unsupported cancellation, and other unmapped codes |
| 2 | Missing template/plan/provider, invalid provider, or modified harness assets |
| 3 | Non-interactive prompt, EOF, or prompt timeout |
| 4 | Plan locked |
| 5 | Dirty worktree |
| 6 | Maximum steps exceeded |
| 7 | Invalid structured worker output |
| 8 | Phase checklist incomplete or phase not found |
| 9 | Required session continuity missing |
| 130 | Interrupted (SIGINT) |
| 143 | Terminated (SIGTERM) |

## Prompt behavior

Prompts are durable UUID-addressed records with first-writer-wins answers.
`--run <id>` associates a prompt with a run; prompt workers use explicit identity.
`--timeout <ms>` is in **milliseconds**, unlike invoke's timeout in seconds.

- Non-TTY choose/confirm use `--default` when supplied. Without it, the default
  no-TTY wait is zero; an explicit timeout can allow polling for an answer.
- TTY prompts wait without a deadline unless a timeout is supplied.
- `prompt input` reads piped stdin, regardless of `--multiline`. Its pipe wait
  has no default deadline; EOF/timeout/interruption have distinct outcomes.
- In agent sessions, prefer the host's question/chat UI. Record decisions using
  the installed skill's contract. Governance gates use `review decide`, not a
  generic prompt answer or `human:gate` substitute.

## Windows and PowerShell

Load the optional `5x-windows` skill alongside the foundation/process skill.
Prefer files or pipes for structured results rather than shell-escaped JSON:

```powershell
$state = 5x run state --json | ConvertFrom-Json
$state.data
Get-Content result.json -Raw | 5x protocol validate author --run $env:FIVEX_RUN
5x run record author:implement --run $env:FIVEX_RUN --result '@./result.json'
```

Use separate commands rather than `&&` on older Windows PowerShell. If canonical
plan lookup cannot resolve a worktree copy, inspect `worktree_plan_path` from
run state. Bash examples require Bash and, where JSON is parsed, `jq`.

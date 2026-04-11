---
name: 5x-windows
description: >-
  Optional Windows and PowerShell guidance for 5x workflows. Load alongside
  the core 5x skills only when running on Windows or in PowerShell-based
  terminals.
metadata:
  author: 5x-engineer
---

# Skill: 5x-windows

Supplemental host guidance for Windows terminals. This skill is optional.
Load it only when you are actually running in Windows, PowerShell, or a
Windows-hosted IDE terminal.

## When to Load

- You are on Windows and expect PowerShell semantics.
- You need Windows-native JSON parsing examples.
- You are copying 5x workflow snippets into an IDE, PowerShell, or `pwsh`.

## Shell Differences

- **PowerShell 5.1** does not support `&&`. Use `;` or separate lines.
- **PowerShell 7+** supports `&&`, but `;` still works and is the safest shared example.
- Quote paths with spaces. Prefer `Set-Location -LiteralPath <path>` for repo changes.

Example:

```powershell
Set-Location -LiteralPath "C:\src\repo"
$rendered = 5x template render author-next-phase --run $RUN --var phase_number=1 | ConvertFrom-Json
```

## JSON Parsing

- Do not assume `jq` is installed.
- Prefer `ConvertFrom-Json`, temporary files, or host-native JSON tooling.
- When passing JSON back into `5x run record`, prefer `--result @path/to/file.json` or stdin via `--result -`.

Examples:

```powershell
$rendered = 5x template render reviewer-plan --run $RUN | ConvertFrom-Json
$prompt = $rendered.data.prompt
$step = $rendered.data.step_name
```

```powershell
Get-Content .\result.json -Raw | 5x run record $step --run $RUN --result -
```

## Paths and Worktrees

- Treat the rendered prompt's `## Context` block as authoritative for the effective working directory.
- For run-scoped workflows, prefer `worktree_path` and `worktree_plan_path` from `5x run state` when present.
- `5x plan phases <canonical-path>` can resolve the mapped worktree copy when run from the control-plane repo. If you are outside that context or mapping resolution fails, retry with `worktree_plan_path`.

## Native Harness Notes

- In IDE-native harnesses, keep human gates in chat / native question tools rather than spawning `5x prompt` commands (no TTY in typical agent terminals).
- Continue using the normal 5x workflow semantics: render prompt, delegate, then validate and record at the single recording point.

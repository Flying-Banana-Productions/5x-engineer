# Run Init Worktree Test Matrix

Scope: `5x run init --worktree` and `5x worktree attach`.

| ID | Scenario | Command | Expected |
|---|---|---|---|
| WTI-001 | Missing plan path | `5x run init --plan <missing>` | `PLAN_NOT_FOUND`, exit 2 |
| WTI-002 | New plan, no mapped/candidate worktree | `5x run init --plan <plan> --worktree` | Creates default worktree, maps plan, returns `data.worktree.action = "created"` |
| WTI-003 | Existing explicit worktree path | `5x run init --plan <plan> --worktree <path>` | Attaches path, returns `data.worktree.action = "attached"` |
| WTI-004 | Existing mapped worktree | `5x run init --plan <plan> --worktree` (after map exists) | Returns `data.worktree.action = "reused"` |
| WTI-005 | Ambiguous auto-discovery | `5x run init --plan <plan> --worktree` with multiple matching candidates | `WORKTREE_AMBIGUOUS`, includes candidate list |
| WTI-006 | Explicit path missing | `5x run init --plan <plan> --worktree <missing-path>` | `WORKTREE_NOT_FOUND` |
| WTI-007 | Explicit path exists but not git worktree | `5x run init --plan <plan> --worktree <dir>` | `WORKTREE_INVALID` |
| WTI-008 | Explicit path attach command | `5x worktree attach --plan <plan> --path <path>` | Mapping saved, `attached: true`, branch returned |
| WTI-009 | Attach invalid path | `5x worktree attach --plan <plan> --path <dir>` | `WORKTREE_INVALID` |
| WTI-010 | `--worktree-path` without `--worktree` | `5x run init --plan <plan> --worktree-path <path>` | `INVALID_ARGS` |

Automated coverage in this change:
- `test/commands/run-init-worktree.test.ts`: WTI-001, WTI-002, WTI-003
- `test/commands/worktree-v1.test.ts`: WTI-008, WTI-009

Planned follow-up coverage:
- WTI-004, WTI-005, WTI-006, WTI-007, WTI-010

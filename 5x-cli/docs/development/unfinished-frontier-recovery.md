# Historical unfinished-frontier recovery

`5x review implementation recover-plan` is retired. Do not produce new
`implementation-plan-recovery` receipts. Same-run semantic changes use
authorize → amend → assess → register → resume:

1. Record `authorize_amendment` with structured `amendmentScope`
   (`--predecessor-revision`, `--earliest-affected-phase`,
   `--reopen-completed-phases true|false`, repeatable `--claim-edit`, and
   repeatable `--resolution-ref`). Rationale prose is not scope.
2. Review the exact committed plan hash. The verdict's `amendmentAssessment`
   must copy the trusted predecessor and hash. A final-corrections pass that
   changes those bytes needs a new assessment before registration.
3. Preview with `5x review implementation amend --dry-run`, then register
   without `--dry-run`. Registration does not complete a phase or approve
   implementation.
4. Resume author work from the effective revision.

`5x review implementation bind` only attaches the initial approved source. It
does not replace a binding or repair plan drift.

## Historical receipts

Committed `implementation-plan-recovery` lines remain strict-decodable,
including the original single-recovery key and later authorization-scoped keys.
The effective revision fold treats each one as a `legacy_frontier_recovery`.
Those revisions keep their original authorization, operator attestations, and
invalidated contexts and observations. They are not given a synthetic
`amendmentAssessment`. The `authorize_amendment` decisions they cite stay on
the former contract: they omit `amendmentScope` and cannot authorize `amend`.

The final legacy recovery is a valid predecessor for a new-format amendment.
That amendment still needs the current authorization and assessment contract.
Guarded text amendments may sit before, between, or after legacy recoveries.

## Upgrade reporting

`5x upgrade` discovers these receipts from the configured record root, including
active, completed, and aborted runs, without an index or a source worktree.
When the working copy is gone, committed journals are read from git history.
The report names recovery identities, lineage validity, and whether the history
is compatible to resume. Compatibility is not implementation completion.
Malformed or ambiguous history fails closed with a diagnostic.

Discovery does not resume runs, rewrite or replace journal lines, append a
synthetic approval, or commit project history. There is no migration record.
Repeat the command; the journals stay unchanged.

## Toolchain

Execute an amended run only with a CLI that understands
`implementation-plan-amendment` and `amendmentScope`. Older binaries may report
drift or ignore unfamiliar records and must not execute those runs. Refresh
installed skills with `5x harness sync` after upgrading the CLI. Changing
bundled Markdown does not by itself refresh an installed override.

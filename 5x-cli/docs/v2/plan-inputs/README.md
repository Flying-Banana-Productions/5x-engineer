# v2 plan inputs

These files split the remaining v2 design into bounded inputs for separate implementation-plan runs. The canonical product intent remains in `docs/v2/200-overview.md` and the linked area documents.

## Recommended order

| Order | Slice | Depends on |
|---:|---|---|
| 1 | `01-recovery-and-doctor.plan-input.md` | Implemented area 201 |
| 2 | `02-run-context-ergonomics.plan-input.md` | None beyond v1 |
| 3 | `03-prompt-queue-foundation.plan-input.md` | Slice 1; completes its deferred prompt check |
| 4 | `04-control-plane-dashboard.plan-input.md` | Slice 3 |
| 5 | `05-invocation-registry.plan-input.md` | Slice 4 |
| 6 | `06-review-budget-advisory.plan-input.md` | Slice 3 |
| 7 | `07-plan-review-governance.plan-input.md` | Slices 4 and 6 |
| 8 | `08-implementation-review-governance.plan-input.md` | Slice 7 |
| 9 | `09-output-normalization-release.plan-input.md` | Slices 1-8 |
| 10 | `10-git-native-run-records.plan-input.md` | Slice 3; its phase-1 `RecordStore` interface is consumed by slice 6, which proceeds in parallel |

Slices 1 and 2 may be implemented in parallel. After slice 3, slice 4 and slice 6 may also proceed in parallel. Slice 5 establishes only the provider-neutral invocation registry and cancellation contract; provider-specific cancellation adapters, including OpenCode process handling formerly proposed by plan 011, are follow-up work after the v2 foundation is proven.

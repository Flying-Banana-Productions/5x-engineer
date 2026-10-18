# v2 plan inputs

These files split the v2 design into bounded inputs for separate implementation-plan runs. The canonical product intent remains in `docs/v2/200-overview.md` and the linked area documents. Status reflects the current repository state, including plans and implementations completed from these inputs.

## Recommended order

| Order | Plan input | Generated implementation plan | Implementation status | Depends on |
|---:|---|---|---|---|
| 1 | [`01-recovery-and-doctor.plan-input.md`](./01-recovery-and-doctor.plan-input.md) | [`203-recovery-and-doctor-plan.md`](../../development/plans/203-recovery-and-doctor-plan.md) | Complete | Implemented area 201 |
| 2 | [`02-run-context-ergonomics.plan-input.md`](./02-run-context-ergonomics.plan-input.md) | [`204-run-context-ergonomics-plan.md`](../../development/plans/204-run-context-ergonomics-plan.md) | Complete | None beyond v1 |
| 3 | [`03-prompt-queue-foundation.plan-input.md`](./03-prompt-queue-foundation.plan-input.md) | [`205-prompt-queue-foundation-plan.md`](../../development/plans/205-prompt-queue-foundation-plan.md) | Complete | Slice 1; completes its deferred prompt check |
| 4 | [`04-control-plane-dashboard.plan-input.md`](./04-control-plane-dashboard.plan-input.md) | Not generated | Not started | Slice 3 |
| 5 | [`05-invocation-registry.plan-input.md`](./05-invocation-registry.plan-input.md) | [`207-invocation-registry-plan.md`](../../development/plans/207-invocation-registry-plan.md) | Complete | Slice 4 |
| 6 | [`06-review-budget-advisory.plan-input.md`](./06-review-budget-advisory.plan-input.md) | [`208-review-budget-advisory-plan.md`](../../development/plans/208-review-budget-advisory-plan.md) | Complete | Slice 3 and slice 10's `RecordStore` foundation |
| 7 | [`07-plan-review-governance.plan-input.md`](./07-plan-review-governance.plan-input.md) | [`209-plan-review-governance-plan.md`](../../development/plans/209-plan-review-governance-plan.md) | Complete | Slice 6; dashboard integration remains separate |
| 8 | [`08-implementation-review-governance.plan-input.md`](./08-implementation-review-governance.plan-input.md) | [`210-implementation-review-governance-plan.md`](../../development/plans/210-implementation-review-governance-plan.md) | Complete | Slice 7 |
| 9 | [`09-output-normalization-release.plan-input.md`](./09-output-normalization-release.plan-input.md) | Not generated | Not started | Slices 1-8 |
| 10 | [`10-git-native-run-records.plan-input.md`](./10-git-native-run-records.plan-input.md) | [`212-git-native-run-records-plan.md`](../../development/plans/212-git-native-run-records-plan.md) | Complete | Slice 3; its `RecordStore` interface is consumed by slice 6 |

Slices 1, 2, 3, 5, 6, 7, 8, and 10 are complete on main, including the recently merged plan 210. Slices 4 and 9 remain unimplemented; slice 9 still depends on slice 4. Plan- and implementation-review governance shipped independently of the dashboard; dashboard integration remains separate. Slice 5 establishes only the provider-neutral invocation registry and cancellation contract; provider-specific cancellation adapters, including OpenCode process handling formerly proposed by plan 011, are follow-up work after the v2 foundation is proven.

## Follow-up plans

[`215-implementation-plan-amendment-plan.md`](../../development/plans/215-implementation-plan-amendment-plan.md) is a required follow-up to completed plan 210. It adds same-run registration of human-authorized, reviewer-approved semantic plan amendments, with immutable revision lineage and revision-aware evidence handling. Plan 215 is draft, pending review; with plan 210 now merged, review and approve 215 before implementing it in a separate branch.

---
description: Staff Engineer level code review
agent: build
model: openai/gpt-5.2
---

We are reviewing work done at commit $1 and any follow-on commits. 

Review from a Staff Engineer perspective:
- Correctness
- Architecture
- Tenancy/security
- Performance
- Operability
- Test strategy
- Any other staff-level concerns

If the commit(s) reference an implementation plan document, they should relate to one or more phases of work in the implementation plan. If you can deduce the phase(s) then include a readiness assessment for moving to the next phase of development in the plan, or if the plan can be considered complete if there are no remaining phases. Otherwise you can offer a general production readiness assessment for the work done.

If the commit references an existing review document, your goal is to validate that the commit(s) addressed the issues raised in the review document (either the main body of the review or the latest addendum).

If there is an existing review document, write your assessment to the same document as a new addendum; otherwise create a new review document in @docs/development/reviews. Use  _review_template.md from the folder as the review format if available, otherwise follow existing conventions. 


---
description: Revise work based on documented code review
agent: plan
model: anthropic/claude-opus-4-5
---

Read the review document $1 and create a plan to address all actionable feedback. Include in your plan updates to any related implementation plan document or technical design documentation as necessary to maintain consistency. The review document will either be new or it will have one or more addendums. If addendums exist your task will be to work on the latest addendum, not the main body of the review (though you may want to do a quick sanity check to make sure the code base already addresses the main body review).

If the task is to revise a design or implementation plan document, DO NOT preemptively implement any code changes - only revise the document(s) under review. In this case you may skip the test running steps below as well to save time and tokens.

When finished:

- re-read the review document and double check that all concerns were addressed
- make sure all tests pass (integration, unit, component, and e2e as configured)
- commit changes; be sure to make reference to the related review document location and (if applicable) which addendum was addressed.

---
description: Start or continue work on an implementation plan
agent: build
model: anthropic/claude-opus-4-5
---

We are working on the implementation plan $1. Read the plan and determine which phase we are working on - either continuing a partially finished phase or starting a new phase.

If we are starting a new phase, either validate that we are on a new branch that has a name related to the implementation plan, or create a new branch named for the implementation plan + a suffix for the phase that will be worked on. If we're in a branch that seems unrelated to the work, pause and ask the user to verify that they want to continue on the current branch.

For any UI/UX design tasks, invoke the frontend-design skill (if available).

When you are finished with the phase work, do the following: 

- make sure all tests pass (integration, unit, component, and e2e as configured)
- update the implementation plan to reflect the completed progress
- commit changes; be sure to make reference to the implementation plan and phase number that was worked on

Additional notes from user may be included after this line:
$2

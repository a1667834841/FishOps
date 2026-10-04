---
name: refine
description: Review the current conversation and turn validated, reusable lessons into skills. Prefer updating existing skills over creating new ones.
---

# Refine

Review the current conversation and extract reusable procedural knowledge.

The goal is not to summarize the conversation, but to answer:

> What should the agent do better next time when facing a similar task?

## Workflow

1. Review the conversation for:
   - user corrections
   - mistakes and verified fixes
   - better workflows
   - useful techniques
   - missing validation steps
   - reusable pitfalls

2. Keep a lesson only if it is:
   - reusable
   - validated
   - useful for future similar tasks

3. Search existing skills first.

Prefer:

```text
update existing skill
→ add reference/script/template
→ create new skill
```

Do not create a new skill if an existing one can reasonably contain the lesson.

4. Read the current skill before editing it.

5. Patch the existing rule instead of appending correction history.

Bad:

```text
Old approach: X
Update: use Y
```

Good:

```text
Use Y when condition Z applies.
```

6. Do not save:
   - temporary environment failures
   - unverified guesses
   - failed approaches with no confirmed solution
   - timestamps, ticket IDs, branch names, or one-off incident details
   - duplicate knowledge

7. New skills should describe a class of tasks.

Good:

```text
git-worktree-workflow
deployment-debugging
agent-evaluation
```

Bad:

```text
fix-error-1234
october-deployment
```

## Decision

```text
lesson
  ↓
reusable?
  ↓ yes
validated?
  ↓ yes
existing skill?
  ├─ yes → read → patch
  └─ no  → create only if broadly reusable
```

## Output

Report only actual changes:

```text
Refined:
- deployment-debugging: added health-check verification
- git-worktree-workflow: improved merge procedure
```

If nothing useful was learned:

```text
Nothing to save.
```
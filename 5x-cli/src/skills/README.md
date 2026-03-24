# Shared Skill Template System

`src/skills/` is the single source of truth for bundled 5x skills used by all
harness plugins.

## Layout

```
src/skills/
  base/
    5x/SKILL.tmpl.md
    5x-plan/SKILL.tmpl.md
    5x-plan-review/SKILL.tmpl.md
    5x-phase-execution/SKILL.tmpl.md
  renderer.ts            Conditional template renderer
  loader.ts              Template registry + render helpers
  frontmatter.ts         Shared SKILL.md frontmatter parser
```

## Base Templates

Each skill lives at `src/skills/base/<name>/SKILL.tmpl.md` and includes YAML
frontmatter plus markdown body content.

Templates are rendered in one of two modes:

- `native: true` -> native harness delegation (Task/subagents path)
- `native: false` -> invoke delegation (`5x invoke` path)

## Conditional Block Syntax

`renderer.ts` supports line-based directives:

- `{{#if native}}`
- `{{#if invoke}}`
- `{{else}}`
- `{{/if}}`

Rules:

- Directive must be the full line (no leading/trailing content)
- Directive lines are removed from output
- Nesting is not supported
- Unmatched/unclosed directives throw

Example:

```md
{{#if native}}
Use Task tool delegation.
{{else}}
Use 5x invoke delegation.
{{/if}}
```

## Rendering Pipeline

```
base SKILL.tmpl.md
  -> renderSkillTemplate(template, ctx)
  -> parseSkillFrontmatter(rendered)
  -> renderAllSkillTemplates(ctx)
  -> harness plugin installSkillFiles(...)
```

Where `ctx` is `SkillRenderContext` from `renderer.ts`.

## Adding a New Conditional Variable

Current renderer supports only built-in `native` and `invoke` predicates. To
add another variable:

1. Extend `SkillRenderContext` in `renderer.ts`.
2. Extend directive parsing logic in `renderSkillTemplate()` (new `{{#if ...}}` selector).
3. Add unit tests in `test/unit/skills/renderer.test.ts` for true/false/else/error cases.
4. Add/adjust loader tests in `test/unit/skills/loader.test.ts`.
5. Update this README and template docs to describe the new directive semantics.

Keep conditionals sparse; prefer shared prose unless behavior truly differs by
harness/delegation mode.

# Domain docs

This is a single-context repository.

## Before exploring

Read:

- `CONTEXT.md` at the repository root.
- The ADRs under `docs/adr/` that affect the area being explored.

If either location is absent, proceed silently. Domain documentation is created lazily when terminology or decisions are resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   └── agents/
└── src/
```

## Use the glossary’s vocabulary

When naming a domain concept in an issue, specification, proposal, hypothesis, or test, use the term defined in `CONTEXT.md`. Do not drift to synonyms that the glossary explicitly avoids.

If a needed concept is missing, reconsider whether it belongs to the existing language or note the gap for the domain-modeling skill.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface that conflict explicitly instead of silently overriding the decision:

> _Contradicts ADR-0007 — but worth reopening because…_

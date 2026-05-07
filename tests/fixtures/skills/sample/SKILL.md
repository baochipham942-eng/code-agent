---
name: sample
description: Test fixture for skill-loader unit tests
artifact_kind: game
subtype: platformer
declared_verbs:
  - verb: defeat
    selector: enemiesDefeated
    success: { op: increase, path: enemiesDefeated }
    required: true
  - verb: collect
    selector: coinsCollected
    success: { op: increase, path: coinsCollected }
---

# Sample Skill

This is a test fixture — used by `tests/unit/agent/runtime/game/skill-loader.test.ts`.

## Generation Contract

Sample artifact must include `step('jump')` and `snapshot()` returning `{ enemiesDefeated, coinsCollected }`.

### Sub-section under contract

This sub-section is intentionally nested to test `extractSection` heading scoping.

## Repair Hints

If `verb_no_evidence` for `defeat`, ensure stomping increments `enemiesDefeated`.

## Reference Examples

See `mechanics.md` (not present in fixture).

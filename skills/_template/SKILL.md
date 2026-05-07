---
name: TODO-skill-name
description: TODO 一句话描述（给 LLM 看，soft dispatch 用）
artifact_kind: game
subtype: TODO-subtype-or-remove-this-line-if-not-game
declared_verbs:
  - verb: TODO-verb-id
    selector: TODO.snapshot.path
    success: { op: increase, path: TODO.snapshot.path }
    required: true
---

# TODO Skill Name

简短介绍这个 skill 是干什么的、什么场景触发。

## Generation Contract

注入到 generation prompt 的内容写这里 — 描述产物长什么样、必须满足的约束。
保持简洁，能写在这里的不要写代码示例。

## Repair Hints

| Failure Code | Hint |
|--------------|------|
| TODO_failure_code | TODO 修复指导 |

## Reference Examples

链接到 `mechanics.md` / `probes.md` / 外部样例。

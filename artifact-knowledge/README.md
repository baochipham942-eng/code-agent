# Skills

`skills/` 目录是 game subtype 与其他 artifact-kind 知识包的家。每个 skill 是一个目录，
包含一份 `SKILL.md` manifest（YAML frontmatter + markdown body），可选附带补充
reference 文件（mechanics.md / probes.md / 示例 fixture 等）。

设计意图见 [docs/audits/2026-05-07-game-acceptance-architecture.md §5](../docs/audits/2026-05-07-game-acceptance-architecture.md#5-proposed-architecture)：

- **Layer A** — TS hard dispatch by ArtifactKind（`game` / `slide-deck` / ...）
- **Layer B** — 这里的 skills（progressive disclosure），决定 generation 时塞什么 domain knowledge
- **Layer C** — declarative verb probes（验收 ground truth）

## 目录约定

```
skills/
├── README.md                    本文件
├── _template/                   新 skill 起步模板（loader 跳过 `_` 开头目录）
│   └── SKILL.md
├── platformer-game/             单个 skill 目录 — 名字与 frontmatter.name 对齐
│   ├── SKILL.md                 必需 — manifest
│   ├── mechanics.md             可选 — 机制详解（progressive disclosure）
│   └── probes.md                可选 — 验收 probes 详解
└── ...
```

`loadAllSkills(skillsRoot)` 一层目录扫描，跳过 `.` 和 `_` 开头的目录。

## SKILL.md frontmatter schema

精确字段定义见 `src/host/agent/runtime/game/skill-loader.ts` 的 `SkillFrontmatter`。
最小可用 frontmatter:

```yaml
---
name: platformer-game
description: Mario-style 2D platformer with jump-stomp-collect mechanics
artifact_kind: game
subtype: platformer
declared_verbs:
  - { verb: defeat, selector: enemiesDefeated, success: { op: increase, path: enemiesDefeated } }
  - { verb: collect, selector: blocksUsed, success: { op: increase, path: blocksUsed } }
  - { verb: unlock, selector: gatesUnlocked, success: { op: increase, path: gatesUnlocked } }
---
```

必填字段:

- `name`: 唯一 skill 标识，与目录名一致
- `description`: 一句话描述，给 LLM 看的（soft dispatch by description match）
- `artifact_kind`: `'game' | 'slide-deck' | 'document' | 'data-workbook' | 'dashboard' | 'code-project' | 'image' | 'other'`

可选字段:

- `subtype`: 仅 `artifact_kind: game` 时需要（`'platformer' | 'runner' | 'tower-defense' | ...`）
- `declared_verbs`: 用 6-class verb taxonomy 声明的 verbs（见 `src/host/agent/runtime/game/verbs.ts`）

## Body 约定（progressive disclosure）

Loader 提供 `extractSection(body, '## Generation Contract')` 这种小节抽取，
推荐 SKILL.md 维护这几节让上层按需加载：

- `## Generation Contract` — generation prompt 注入用，描述目标产物长什么样
- `## Repair Hints` — 失败 code → 修复提示的字典
- `## Reference Examples` — 链接到附带的 fixture 或外部参考

## 添加新 skill 三步

1. 复制 `skills/_template/` 到 `skills/<your-skill-name>/`
2. 改 `SKILL.md` 的 frontmatter（name / description / artifact_kind / 可选 subtype + declared_verbs）
3. 填 body 各小节，至少给出 Generation Contract

写完跑一遍单元测试确认 loader 不抱怨：

```bash
npm test tests/unit/agent/runtime/game/skill-loader.test.ts
```

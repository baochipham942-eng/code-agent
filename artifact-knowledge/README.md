# 产物知识包

这个目录给 Agent Neo 的产物生成和验收提供参考知识。比如生成平台跳跃游戏时，系统需要知道跳跃、踩怪、收集、通关这些玩法怎么描述、怎么检查、失败后怎么修。

它原名 `skills/`，2026-06 改成 `artifact-knowledge/`，用来和两类真正的技能区分开：

- `.agents/skills/`：随仓库内置的 Agent 任务能力，比如 docx、excel、ppt、pr。
- `~/.code-agent/skills/`：用户机器上的运行时技能，来自安装或 marketplace。

代码里还会看到 `SKILL.md`、`loadAllSkills` 这些历史名字。阅读时可以把这里的 `skill` 理解成“产物知识包”，它服务于产物生成和验收。

工作方式分三层：

- TypeScript 代码先判断产物类型，例如 `game`、`slide-deck`、`dashboard`。
- 这里的知识包补充具体产物该长什么样、有哪些规则、失败时怎么修。
- 验收 probe 用声明式规则检查产物行为。

## 目录约定

```
artifact-knowledge/
├── README.md          本文件
├── _template/         新知识包起步模板，loader 会跳过 `_` 开头目录
├── platformer-game/   平台跳跃游戏知识包
│   ├── SKILL.md       必需，写名称、描述、产物类型、验收动作
│   ├── mechanics.md   可选，玩法机制说明
│   └── probes.md      可选，验收 probe 说明
└── runner/            跑酷游戏知识包
```

`loadAllSkills(skillsRoot)` 一层目录扫描，跳过 `.` 和 `_` 开头的目录。

## `SKILL.md` 写什么

精确字段定义见 `src/host/agent/runtime/game/skill-loader.ts` 的 `SkillFrontmatter`。最小可用内容：

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

必填字段：

- `name`: 唯一标识，与目录名一致
- `description`: 一句话描述，用来帮助系统挑选合适知识包
- `artifact_kind`: `'game' | 'slide-deck' | 'document' | 'data-workbook' | 'dashboard' | 'code-project' | 'image' | 'other'`

可选字段：

- `subtype`: 仅 `artifact_kind: game` 时需要（`'platformer' | 'runner' | 'tower-defense' | ...`）
- `declared_verbs`: 用 6-class verb taxonomy 声明的 verbs（见 `src/host/agent/runtime/game/verbs.ts`）

## Body 约定（progressive disclosure）

Loader 提供 `extractSection(body, '## Generation Contract')` 这种小节抽取，
推荐 SKILL.md 维护这几节让上层按需加载：

- `## Generation Contract`: 描述目标产物应该具备哪些行为和内容。
- `## Repair Hints`: 把常见失败原因映射到修复建议。
- `## Reference Examples`: 链接到附带 fixture 或参考样例。

## 添加新知识包

1. 复制 `artifact-knowledge/_template/` 到 `artifact-knowledge/<your-pack-name>/`
2. 改 `SKILL.md` 的 frontmatter（name / description / artifact_kind / 可选 subtype + declared_verbs）
3. 填 body 各小节，至少给出 Generation Contract

写完跑一遍单元测试确认 loader 不抱怨：

```bash
npm test tests/unit/agent/runtime/game/skill-loader.test.ts
```

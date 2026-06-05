# 角色创建流程：对话式搭建 + 草稿确认落盘

> 状态：设计稿（待 owner 拍板开工）
> 关联：[[persistent-role-assets]]（角色资产底座）、[[role-proactivity]]（角色主动性）
> 上游背景：`docs/research/2026-06-02-coze-codeg-cumora-competitive-analysis.md`

## 1. 背景与现状（这是个真空）

持久化角色（[[persistent-role-assets]]）MVP 已上线，但**创建入口被明确推迟**——设计文档原文把"用户自建角色的 UI 引导"列进下期非 MVP 范围，当前自建角色 = 手动往 `~/.code-agent/roles/<name>/` 建目录 + 写 `agents/<id>.md`。

真空有两层：

1. **角色没有创建入口**——设置页"角色"面板只能 看 / 删记忆 / 调主动性，不能新建。
2. **底层 custom-agent 本身也没有创建 UI**——`agentRegistry` 只从磁盘 `agents/*.md` 扫描发现（`agentRegistry.ts:259-266` 只认 `.md`），全靠用户手写文件。

结论：角色 = 自定义 agent（frontmatter: name/description/tools + system prompt）+ `roles/<id>/` 持久化目录。要补的不是一个表单，是一条**让普通用户把"我想要个什么角色"变成一份合法 agent 定义**的路径。

## 2. 竞品对标（为什么走对话式，不走表单）

| 竞品 | 创建方式 |
|------|---------|
| Cumora（最贴 Neo） | personas 可 编辑/解雇/**招新**，从预设人格库派生或新招 |
| 扣子 Coze 3.0 | 4 来源，主推**对话式原生搭建** + 职业模板一键生成 |
| GPT Builder / WorkBuddy | 对话式访谈 → 自动配置 → 预览 → 确认 |
| Codex for Every Role | 卖"装备包"（role plugin），不卖人格 |

纯表单的死穴：角色定义里有 `tools` 白名单（预设研究员就挂了 9 个工具、数据分析师 12 个），让非技术用户从 30+ 工具名里勾选直接劝退。**对话式让模型来访谈、起草、勾工具，用户只需自然语言描述和确认**——这也最贴 Neo 作为 cowork 产品的品类（[[feedback_agent_neo_is_cowork_product]]）：用 Neo 自己的 agent loop 去造一个新 agent。

## 3. 核心模型：三段分工

```
设置页入口（点火）  →  对话页（定义+迭代）  →  确认闸（落盘）
   薄                    模型当"角色架构师"        显式确认才写文件
```

- **设置页入口 = 只点火，不做真配置**。一个"+ 新建角色"按钮，最多收一句种子描述（"你想要个什么角色"）。**不在设置页放 tools/system prompt**，否则两处都能配 → 用户不知以谁为准。设置页字段唯一作用是喂对话第一句。
- **对话页 = 真正定义发生地**。模型扮演角色架构师：① 访谈（干什么活/什么场景/要不要联网读写）② 起草完整定义（name/description/分类/tools/system prompt）→ 渲染**预览卡** ③ 迭代（"工具太多去掉 Bash""语气专业点"，改草稿）④ 用户点"创建"才落盘。
- **确认闸 = 模型不能自己 commit**。草稿一直是草稿态，不进 `agents/` 目录（否则没确认就被 agentRegistry 扫到、半成品提前上岗）；只有用户点确认按钮触发写盘。

## 4. 复用既有范式：skillDraftQueue（关键，不重造轮子）

Neo **已经有一套一模一样的"草稿 → 聊天卡确认 → 落盘"闭环**，只是用在 skill 蒸馏上。角色创建镜像它即可：

| Skill 现成件 | 角色对应件 | 作用 |
|-------------|-----------|------|
| `services/skills/skillDraftQueue.ts` | 新增 `services/roleAssets/roleDraftQueue.ts` | 草稿入队/列举/确认/拒绝 |
| `skill-drafts/`（与 skills/ 平级，不被 discovery 扫，`memory.ts:152`）| `role-drafts/`（与 roles/ 平级，不被 agentRegistry 扫）| 草稿态隔离目录 |
| `draft.json` + `SKILL.md` | `draft.json` + `agent.md` | 草稿内容 |
| `enqueueSkillDraft()` | `enqueueRoleDraft()` | 模型提案 → 入队 |
| `confirmSkillDraft()`（`skillDraftQueue.ts:319`）| `confirmRoleDraft()` | 落盘 + rm 草稿 |
| `scanSkillContent()` fail-closed 安全闸 | 同款内容扫描 | 拦危险命令/明文密钥 |
| `SkillDraftCard.tsx` / `SkillDraftNotifications` | 新增 `RoleDraftCard.tsx` | 聊天流里的确认卡 |
| `skill.ipc.ts` list/confirm/reject | `roles.ipc.ts` 加同名 draft 动作 | IPC 接线 |

`confirmSkillDraft` 的落盘范式可直接照搬（读 draft → 安全扫描 → 写正式目录 → rm 草稿 → 记 accepted ledger），角色版把"写 SKILL.md"换成"写 `agents/<id>.md` + 调 `installRolePersistence(roleId)`（即 `roleAssetService.ts:108` 那段 mkdir `roles/<id>/` + 建 index/history 的逻辑）"。

## 5. 模型如何提案：propose_role 工具 + 建角色 skill

对话页那段"模型当架构师"靠两件东西驱动：

1. **内置"建角色"skill**（`builtinSkills.ts` 新增一条，对照 skill-creator 范式）：定义访谈流程、起草规范、确认话术。设置页入口按钮 = 带种子 prompt 起一个挂这个 skill 的会话。把"怎么建角色"做成可维护资产，不写死在前端。
2. **`propose_role` 工具**（模型在对话里调用）：入参 = 起草好的角色定义（name/description/category/tools/systemPrompt）→ 内部调 `enqueueRoleDraft()` 生成草稿 + 触发 `RoleDraftCard` 渲染。对照 `learningPipeline.ts` 调 `enqueueSkillDraft` 的方式。模型每次迭代调一次，卡片更新为最新草稿。

## 6. 落点表（接手即用）

| 模块 | 位置 | 改动 |
|------|------|------|
| 草稿队列 | `src/main/services/roleAssets/roleDraftQueue.ts`（新建）| 镜像 skillDraftQueue |
| 草稿目录常量 | `src/shared/constants/memory.ts` `ROLE_ASSETS` | 加 `DRAFTS_DIR_NAME: 'role-drafts'` |
| 落盘逻辑 | 复用 `roleAssetService.ts` 的 `installRolePersistence` + 新写 agent.md | confirmRoleDraft 调 |
| 提案工具 | `src/main/tools/modules/.../proposeRole.ts`(+ .schema)（新建）| 调 enqueueRoleDraft |
| 建角色 skill | `src/main/services/skills/builtinSkills.ts` | 新增"建角色"条目 |
| IPC | `src/main/ipc/roles.ipc.ts`（现有 list/detail/deleteMemory/updateMemory/setProactivity）| 加 `listDrafts/confirmDraft/rejectDraft` |
| 设置页入口 | `src/renderer/components/features/settings/tabs/RolesTab.tsx` | 加"+ 新建角色"按钮 → 起会话 |
| 聊天页入口（主）| `src/renderer/components/StatusBar/AgentSwitcher.tsx` | 下拉 footer 加"＋ 新建角色"（与"恢复默认 agent"并列）→ 起会话；与设置页共用同一路径 |
| 聊天确认卡 | `src/renderer/.../chat/ChatInput/RoleDraftCard.tsx`（新建）| 镜像 SkillDraftCard |
| agentRegistry 排除 | `agentRegistry.ts` 扫描时跳过 `role-drafts/` | 防草稿被当正式 agent |

## 7. 关键设计决策

1. **入口放哪**（owner 已拍）：**两处都放，共用同一条代码路径**（都是"start 一个建角色 session"）。
   - 设置页：角色面板右上"+ 新建角色"按钮（管理心智）。
   - 聊天页（主入口）：**`AgentSwitcher` 下拉底部加"＋ 新建角色"**（`StatusBar/AgentSwitcher.tsx`，与现有"恢复默认 agent"footer 并列）——该下拉本就是"跟哪个角色干活"的选择器，对标 Cumora"团队名单里招新"。点击 = 起一个挂"建角色"skill 的**新会话**（独立 meta 对话，不污染当前工作会话）。
   - 次入口（下一阶段，先不做）：`@` 落空兜底——`@<不存在的角色>` 时 inline 提示"现在招一个?"。
2. **先做"新建"，不做"改已有"**（owner 已拍）：本期只做新建。"对话式改已有角色"作为下期，draft 结构预留 `editingRoleId` 字段以便复用。
3. **tools 怎么呈现给用户**：由模型在对话里按需勾选并解释（"我给你挂了联网+读写文件，要不要加终端？"），用户不直接面对工具清单。新建默认可继承一个预设角色的 tools 起步。
4. **草稿生命周期**：未确认草稿留 `role-drafts/`，用户可在面板看/删；是否设过期清理（对照 skill 的 accepted/rejected ledger）。

## 8. 安全（直接复用，不放松）

- confirmRoleDraft 落盘前过 `scanSkillContent` 同款 fail-closed 内容扫描——角色 system prompt 里若被注入危险命令/明文密钥则拒绝入库，草稿留队列待用户查删。
- tools 白名单由模型提案但**确认卡必须明示**用户这个角色将拥有哪些能力（尤其 Bash/写文件/网络），让用户在确认前看清权限面。

## 9. 验收（E2E，owner 不读代码 → 实证）

- **AC1**：设置页点"+ 新建角色" → 起会话 → 描述需求 → 模型起草并出预览卡 → 确认 → 角色出现在面板，`agents/<id>.md` + `roles/<id>/` 已落盘。
- **AC2**：迭代——确认前说"去掉 Bash" → 卡片刷新，落盘后的 tools 不含 Bash。
- **AC3**：不确认就关会话 → `agents/` 无该文件，agentRegistry 不识别，草稿留 `role-drafts/`。
- **AC4**：安全闸——构造含危险命令的 system prompt 草稿 → 确认被拒，给出原因，草稿保留。
- **AC5**：新建角色可被正常 @ 调用并写回记忆（接 [[persistent-role-assets]] 既有闭环）。

脚本对照 `scripts/acceptance/role-assets-e2e.ts` 的假 HOME 隔离 + webServer headless 范式。

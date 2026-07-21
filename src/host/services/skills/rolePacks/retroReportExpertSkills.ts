// ============================================================================
// Role Pack Skills — 明镜·复盘专家（E1，内置分发）
// 内容正本：private-archive docs/lab/2026-07-21-role-packs-e1-draft/retro-report-expert/
// ============================================================================

import type { ParsedSkill } from '../../../../shared/contract/agentSkill';

export const RETRO_REPORT_EXPERT_SKILLS: ParsedSkill[] = [
  {
    name: 'weekly-report-synthesis',
    description:
      '周报萃取 — 从会话/文件/任务里捞证据攒周报，去重归类、对齐补漏、翻译成读者语言。触发词：周报、工作汇报、周总结、想不起来做了啥。',
    promptContent: `# 周报萃取

解决"写周报想不起来干了啥"。先主动捞证据，别让协作者对着空文档回忆。

## 触发场景

- "帮我写周报""这周做了啥整理一下""周五了写个周报"
- 需要把散落的工作攒成一份周报

## 步骤

1. **先捞，别问**：History/SessionManager 翻本周会话，Glob/ListDirectory 找本周产出文件，TaskManager 看完成任务。
2. **去重归类**：同一件事散在多处就合并，按项目/工作类型归类。
3. **对齐补漏**：把捞到的列给协作者，问"还有没有没体现在记录里的"——补充比回忆省力。
4. **翻译成读者语言**：给领导讲结果和价值，给团队可带过程。技术黑话换人话。
5. **套模板**：有固定格式就贴着来（读角色记忆），没有用默认结构。

## 产出模板

\`\`\`markdown
# 周报 <日期区间>

## 本周核心（3 条以内）
- <最值得说的成果，带结果/数字>

## 分项进展
| 项目/方向 | 做了什么 | 结果 | 状态 |
|-----------|----------|------|------|

## 遇到的问题 & 需要的支持
- <卡点 + 需要谁帮什么>

## 下周计划
- <重点，别列一长串>
\`\`\`

## 自检清单

- [ ] 先捞了会话/文件/任务，不是让协作者从零回忆
- [ ] 做过去重归类，同一件事没重复列
- [ ] 跟协作者对齐补漏过
- [ ] 成果带结果/数字，不是"做了很多工作"
- [ ] 按汇报对象调了语言，无未翻译的技术黑话
- [ ] 没有把记录里没有的写成做了`,
    basePath: '',
    allowedTools: ['Read', 'Glob', 'Grep', 'ListDirectory', 'History', 'SessionManager', 'TaskManager', 'MemoryRead', 'Write'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'project-retro',
    description:
      '项目复盘 — 还原时间线、对目标、拆好与坑、每个坑配下次怎么改的 action。触发词：复盘、项目复盘、项目总结、回顾、retro、做得怎么样。',
    promptContent: `# 项目复盘

复盘不是流水账，是"哪里好、哪里坑、下次怎么改"。没有 action 的复盘等于没做。

## 触发场景

- "复盘一下这个项目""项目结束了做个总结""这次做得怎么样"

## 步骤

1. **还原时间线**：从会话/文件/任务捞出项目从启动到现在的关键节点，排成时间线。
2. **对目标**：当初目标是什么、实际达成多少、差距在哪。没明确目标就先跟协作者确认当初想达成什么。
3. **拆好与坑**：哪些做对了值得沉淀成方法，哪些踩了坑——对事不对人。
4. **每个坑配 action**：下次具体怎么改，可执行。
5. **沉淀经验**：可复用的方法和教训 write-back 到记忆，下个项目能用。

## 产出模板

\`\`\`markdown
# 项目复盘：<项目名>

## 目标 vs 实际
| 当初目标 | 实际达成 | 差距 |

## 关键时间线
<启动 → 里程碑 → 现在>

## 做对了（可复用）
- <方法 + 为什么有效>

## 踩过的坑
| 坑 | 影响 | 根因 | 下次怎么改（action） |

## 一句话总结
\`\`\`

## 自检清单

- [ ] 时间线基于真实证据，不是凭印象
- [ ] 对了目标，差距说清楚了
- [ ] 每个坑有根因和"下次怎么改"的 action，可执行
- [ ] 教训对事不对人
- [ ] 可复用经验 write-back 到记忆`,
    basePath: '',
    allowedTools: ['Read', 'Glob', 'Grep', 'ListDirectory', 'History', 'SessionManager', 'TaskManager', 'MemoryRead', 'MemoryWrite', 'Write'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
  {
    name: 'monthly-review',
    description:
      '月报/阶段汇报 — 聚合周报升维度、量化成果、对里程碑、给领导视角。触发词：月报、月度总结、阶段汇报、季度汇报、领导汇报。',
    promptContent: `# 月报 / 阶段汇报

月报不是四张周报拼一起，是从"做了什么"升到"推进了什么、产生了什么价值"。

## 触发场景

- "写个月报""这个月总结""给领导汇报下阶段进展"

## 步骤

1. **拉长窗口捞证据**：整月的会话/产出/完成任务；已有周报的话直接聚合更省力。
2. **升维度**：抓主线砍细节，从流水账升到价值和推进。
3. **量化成果**：整月可量化产出汇总（完成 N、产出 X、覆盖 Y）。
4. **对里程碑**：这个月在大目标上推进到哪。
5. **给领导视角**：结果和影响放前，过程和方法靠后或省略。需要正式稿用 docx_generate。

## 产出模板

\`\`\`markdown
# 月报 <月份>

## 一句话概括
<这个月最重要的推进>

## 关键成果（量化）
- <成果 + 数字 + 价值>

## 里程碑进展
| 里程碑 | 上月 | 本月 | 状态 |

## 亮点与问题
- 亮点：<>
- 问题与风险：<坦诚，带应对>

## 下月重点
\`\`\`

## 自检清单

- [ ] 是升了维度的月报，不是周报堆叠
- [ ] 成果量化了
- [ ] 对了里程碑/大目标进展
- [ ] 结果和价值在前，细节在后
- [ ] 问题和风险坦诚，带应对，没粉饰`,
    basePath: '',
    allowedTools: ['Read', 'Glob', 'Grep', 'ListDirectory', 'History', 'SessionManager', 'TaskManager', 'MemoryRead', 'docx_generate', 'Write'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
  },
];

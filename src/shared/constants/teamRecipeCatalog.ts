import type { TeamRecipe } from '../contract/teamRecipe';

/** 首发 3 配方（从 E1 内置专家长出，成员为内置角色目录 id）。E5 云下发时整表迁 control plane。 */
export const TEAM_RECIPES: TeamRecipe[] = [
  {
    id: 'product-spec',
    name: '产品规格',
    description: '产品/调研/内容三方协作，把一个想法拆成可落地的产品规格。',
    category: 'product',
    lead: {
      roleId: '牧之',
      briefTemplate: '围绕「{topic}」，统筹溯真的竞品与市场调研、青禾的对外表达稿，定稿一份产品规格：目标用户、核心场景、功能范围、优先级、风险与待决问题。',
    },
    members: [
      { roleId: '溯真', taskTemplate: '为「{topic}」做竞品与市场调研，给出差异化机会与风险。' },
      { roleId: '青禾', taskTemplate: '把「{topic}」的规格提炼成一段对外可讲的清晰说明。' },
    ],
    tags: ['产品', '协作'],
  },
  {
    id: 'deep-research',
    name: '深度调研',
    description: '主理人整合两名研究员并行收集的不同证据面，形成结构化综述。',
    category: 'research',
    lead: {
      roleId: '溯真',
      briefTemplate: '围绕「{topic}」，整合两名证据成员的并行结论，定稿一份结构化综述：核心发现、证据分级、分歧与不确定性、结论及后续研究建议。',
    },
    members: [
      {
        id: 'evidence-a',
        roleId: '溯真',
        taskTemplate: '就「{topic}」收集并核验权威机构、法规、官方公告等一手资料，提取可直接引用的事实、时间点与证据强度。',
      },
      {
        id: 'evidence-b',
        roleId: '溯真',
        taskTemplate: '就「{topic}」梳理行业研究、学术论文与可信案例，比较不同观点、样本或方法的局限，标出相互印证或冲突之处。',
      },
    ],
    tags: ['调研'],
  },
  {
    id: 'content-campaign',
    name: '内容战役',
    description: '内容主理人主导、研究员补数据、复盘顾问审风险，产出一套内容战役方案。',
    category: 'content-marketing',
    lead: {
      roleId: '青禾',
      briefTemplate: '围绕「{topic}」，整合溯真的数据支撑与明镜的风险复盘，定稿一套内容战役方案：目标受众、核心信息、渠道与节奏、内容资产、风险应对和效果衡量。',
    },
    members: [
      { roleId: '溯真', taskTemplate: '为「{topic}」补充事实与数据支撑，标注引用。' },
      { roleId: '明镜', taskTemplate: '对「{topic}」战役方案做复盘与风险审视，给改进建议。' },
    ],
    tags: ['内容', '营销'],
  },
];

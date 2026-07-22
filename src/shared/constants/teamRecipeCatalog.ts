import type { TeamRecipe } from '../contract/teamRecipe';

/** 首发 3 配方（从 E1 内置专家长出，成员为内置角色目录 id）。E5 云下发时整表迁 control plane。 */
export const TEAM_RECIPES: TeamRecipe[] = [
  {
    id: 'product-spec',
    name: '产品规格',
    description: '产品/调研/内容三方协作，把一个想法拆成可落地的产品规格。',
    category: 'product',
    members: [
      { roleId: '牧之', taskTemplate: '就「{topic}」输出产品规格：目标用户、核心场景、功能范围、优先级。' },
      { roleId: '溯真', taskTemplate: '为「{topic}」做竞品与市场调研，给出差异化机会与风险。' },
      { roleId: '青禾', taskTemplate: '把「{topic}」的规格提炼成一段对外可讲的清晰说明。' },
    ],
    tags: ['产品', '协作'],
  },
  {
    id: 'deep-research',
    name: '深度调研',
    description: '两名研究员分工——一人查证一手证据，一人在其上做结构化综述。',
    category: 'research',
    members: [
      { id: 'evidence', roleId: '溯真', taskTemplate: '就「{topic}」检索并核验一手证据，列出来源与可信度。' },
      {
        id: 'synthesis',
        roleId: '溯真',
        taskTemplate: '基于已核验证据，对「{topic}」做结构化综述与结论。',
        dependsOn: ['evidence'],
      },
    ],
    tags: ['调研'],
  },
  {
    id: 'content-campaign',
    name: '内容战役',
    description: '内容主理人主导、研究员补数据、复盘顾问审风险，产出一套内容战役方案。',
    category: 'content-marketing',
    members: [
      { roleId: '青禾', taskTemplate: '为「{topic}」策划内容战役主线：受众、渠道、节奏、核心信息。' },
      { roleId: '溯真', taskTemplate: '为「{topic}」补充事实与数据支撑，标注引用。' },
      { roleId: '明镜', taskTemplate: '对「{topic}」战役方案做复盘与风险审视，给改进建议。' },
    ],
    tags: ['内容', '营销'],
  },
];

// ============================================================================
// Role Assets - 渲染端 / 主进程共享类型（持久化角色资产）
// ============================================================================
//
// 主进程 src/host/services/roleAssets/ 是单一真理源。
// 这里只暴露跨进程序列化后的角色面板类型，供 IPC + 渲染端共用。

import type { AgentSource } from './agentRegistry';
import type { SkillCategory } from './skillRepository';
import type { CronScheduleConfig } from './cron';

/** 角色展示元数据；内置角色与云下发角色包共用这一合同。 */
export interface BuiltinRoleVisual {
  /** lucide 图标名（curated，前端按名渲染） */
  icon: string;
  /** 产物分类（复用 SkillCategory 子集） */
  category: SkillCategory;
  /** 展示名（花名，与 roleId 一致或更口语） */
  displayName: string;
  /** 职业（如“资深产品经理”，展示在花名旁） */
  profession: string;
  /** 能力标签（3 个左右，发现页卡片展示） */
  tags: string[];
  /** 快捷开场 prompt（一句话真实 cowork 场景，点击即发） */
  quickPrompts: string[];
}

/** 用户角色写入 agents/<id>.md frontmatter 的展示层字段。 */
export interface RoleVisual {
  icon?: string;
  category?: SkillCategory;
  displayName?: string;
  profession?: string;
  tags?: string[];
  quickPrompts?: string[];
}

/** 角色面板列表条目（设计 §7：卡片 = 名字/记忆条数/最近工作） */
export interface RolePanelEntry {
  /** 角色 ID = agents/<id>.md 的 frontmatter name = roles/<id>/ 目录名 */
  roleId: string;
  /** 角色描述（来自 agent 定义；无定义时为空） */
  description: string;
  /** agent 定义来源；角色目录存在但 agent 定义缺失时为 'orphan' */
  source: AgentSource | 'orphan';
  /** 角色记忆条数 */
  memoryCount: number;
  /** 最近一条工作履历（原始行） */
  lastWork: string | null;
  /**
   * 角色视觉化（P2-1）：lucide 图标名（curated 子集，见 builtinRoles.ts）。
   * 仅预设角色配死；用户自建角色缺省，前端兜底 UserCircle。
   */
  icon?: string;
  /**
   * 角色产物分类（P2-1）：复用 skillRepository 的 SkillCategory 子集，
   * 与技能包共用一套分类体系。仅预设角色配置；用户自建角色缺省，前端归入"其他"。
   */
  category?: SkillCategory;
  /** 展示名/花名（E1 Role Pack 展示合同）：仅预设角色配置，缺省用 roleId */
  displayName?: string;
  /** 职业（如"资深产品经理"）：仅预设角色配置 */
  profession?: string;
  /** 能力标签：仅预设角色配置 */
  tags?: string[];
  /** 快捷开场 prompt（点击即以此开新会话）：仅预设角色配置 */
  quickPrompts?: string[];
}

// ----------------------------------------------------------------------------
// 专家默认资料架（Batch 3 E3，调研文档 §4.1）
// ----------------------------------------------------------------------------

export type ExpertBindingKind = 'file' | 'folder' | 'library_item';
/** always=索引常驻注入（含摘要）；on_demand=仅列出，正文按需 Read */
export type ExpertBindingMode = 'always' | 'on_demand';
/** private=该专家私有（L1 隔离，不进其他专家）；project=同项目专家可共读（跨专家共读后续批次接线，先存字段） */
export type ExpertBindingScope = 'private' | 'project';

/** 专家 L1 资料架绑定条目，存 roles/<roleId>/bindings.json */
export interface ExpertContextBinding {
  id: string;
  kind: ExpertBindingKind;
  /** file/folder=绝对路径；library_item=LibraryItem id */
  target: string;
  /** 展示名；library_item 缺省用条目标题，路径类缺省用 basename */
  title?: string;
  mode: ExpertBindingMode;
  scope: ExpertBindingScope;
  createdAt: number;
}

/** 角色面板的单条记忆 */
export interface RolePanelMemory {
  filename: string;
  name: string;
  description: string;
  content: string;
  updatedAt: string;
}

/** 详情页反向展示的角色 cron 绑定；编辑仍由自动化面板负责。 */
export interface RoleBoundCronJob {
  id: string;
  name: string;
  schedule: CronScheduleConfig;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  actionType: 'agent' | 'role_wake';
}

// ----------------------------------------------------------------------------
// 角色主动性（内部文档 §4 配置设计）
// ----------------------------------------------------------------------------

/** 主动等级：静默（不醒来）/ 每日简报（默认）/ 实时介入（自定义频率 + 桌面通知） */
export type RoleProactivityLevel = 'silent' | 'daily' | 'realtime';

/** 单个角色的主动性配置（来自 frontmatter proactivity 字段或 settings 覆盖） */
export interface RoleProactivityConfig {
  level: RoleProactivityLevel;
  /** 自定义 cron 表达式（6 字段，croner）；不填用等级默认 */
  cadence?: string;
}

/** settings.json 里的主动性配置（用户级覆盖，优先级高于角色 frontmatter） */
export interface RoleProactivitySettings {
  /** 全局默认主动等级（角色没配置时的兜底） */
  defaultLevel?: RoleProactivityLevel;
  /** per-role 覆盖 */
  roles?: Record<string, RoleProactivityConfig>;
}

/** 醒来循环的四选一决策（设计 §3.2） */
export type RoleWakeDecision = 'advance' | 'report' | 'suggest' | 'silence';

/** 醒来触发方式 */
export type RoleWakeTrigger = 'cadence' | 'event';

/** 一次醒来的执行结果（cron 执行记录 / E2E 验收用） */
export interface RoleWakeResult {
  roleId: string;
  trigger: RoleWakeTrigger;
  /** skipped = 预算护栏拦截（当天次数超限）或角色为 silent 档 */
  status: 'completed' | 'skipped' | 'failed';
  /** status='skipped' 时的原因 */
  skipReason?: string;
  /** 四选一决策（completed 时存在） */
  decision?: RoleWakeDecision;
  /** 醒来会话 ID（completed/failed 时存在） */
  sessionId?: string;
  /** 醒来产出摘要（履历同款） */
  summary?: string;
  /** advance 升级为 goal run 时的终态（met/aborted）；未升级则缺省（P4，内部文档） */
  advanceGoalStatus?: 'met' | 'aborted';
}

/** 角色详情（设计 §7：定义 / 记忆 / 履历 / 主动性） */
export interface RolePanelDetail {
  roleId: string;
  /** agents/<id>.md 原始内容（只读展示）；定义文件缺失时为 null */
  definition: string | null;
  /** agent 定义文件路径（编辑跳转用） */
  definitionPath: string;
  /** 角色记忆（可删可编辑） */
  memories: RolePanelMemory[];
  /** 工作履历（产物清单，最新在后） */
  history: string[];
  /** 主动性配置（解析后的生效值：settings 覆盖 > frontmatter > 出厂默认 silent） */
  proactivity: RoleProactivityConfig;
  /** 编译内预设优先；自建角色取 agents/<id>.md 的扁平 visual frontmatter。 */
  visual: RoleVisual;
  /** 内置角色也允许写入个人展示偏好，但产品更新不会再覆盖这份定义。 */
  isBuiltin: boolean;
  /** 装备层当前生效配置及由 host 解析出的本机可选项。 */
  equipment?: {
    skills: string[];
    tools: string[];
    model: 'fast' | 'balanced' | 'powerful';
    maxIterations: number;
    availableSkills: string[];
    availableTools: string[];
  };
  /** 云包被本地改过时显示；内置和自建角色不使用这条提示。 */
  locallyModified?: boolean;
  /** 自建角色没有出厂定义；云包 registry 不可用时保留入口但禁用。 */
  restore?: { available: boolean; disabledReason?: string };
}

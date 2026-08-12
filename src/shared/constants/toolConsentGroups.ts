// ============================================================================
// 工具 → 用户后果 的分组映射（装专家前的摘要卡用）
// ============================================================================
// 摘要卡是第三方专家包进入前的唯一安全防线，给非程序员看。罗列 Read/Write/Glob
// 这些原名等于没说，所以这里把工具翻成「对你的电脑做什么」，再按后果归组。
//
// 硬约束：**没映射到的工具必须原样露出来**（调用方走 unmapped 分支显示「其他能力：
// <原名>」）。宁可显示一个看不懂的名字，也不能静默漏掉一项能力——漏掉就是骗用户。
// 因此这里刻意不做「白名单过滤」，只做「翻译 + 归组」。
//
// 与工具增减同步靠 tests/unit/shared/toolConsentGroups.test.ts 的 CORE_TOOLS 覆盖用例：
// 新增核心工具没写映射会红。非核心工具不强制，兜底接住。
// ============================================================================

/** 分组：按「对用户意味着什么」切，不按代码模块切。 */
type ToolConsentGroup = 'file' | 'image' | 'memoryTask' | 'network' | 'command' | 'assist';

/** 一句人话的后果。多个工具可以落到同一条（Glob/Grep/ListDirectory 对用户就是一件事）。 */
type ToolConsentEffect =
  | 'readFile'
  | 'writeFile'
  | 'searchFile'
  | 'readImage'
  | 'memory'
  | 'task'
  | 'webSearch'
  | 'webFetch'
  | 'runCommand'
  | 'manageProcess'
  | 'askUser'
  | 'useSkill'
  | 'findTool';

/** 分组展示顺序：后果越重越靠前（能改你电脑的排在能看的前面）。 */
const TOOL_CONSENT_GROUP_ORDER: readonly ToolConsentGroup[] = [
  'command',
  'file',
  'network',
  'image',
  'memoryTask',
  'assist',
];

export const TOOL_CONSENT_MAP: Readonly<Record<string, { group: ToolConsentGroup; effect: ToolConsentEffect }>> = {
  Bash: { group: 'command', effect: 'runCommand' },
  Process: { group: 'command', effect: 'manageProcess' },

  Read: { group: 'file', effect: 'readFile' },
  Blob: { group: 'file', effect: 'readFile' },
  Write: { group: 'file', effect: 'writeFile' },
  Append: { group: 'file', effect: 'writeFile' },
  Edit: { group: 'file', effect: 'writeFile' },
  Glob: { group: 'file', effect: 'searchFile' },
  Grep: { group: 'file', effect: 'searchFile' },
  ListDirectory: { group: 'file', effect: 'searchFile' },

  image_analyze: { group: 'image', effect: 'readImage' },

  MemoryRead: { group: 'memoryTask', effect: 'memory' },
  MemoryWrite: { group: 'memoryTask', effect: 'memory' },
  EpisodicRecall: { group: 'memoryTask', effect: 'memory' },
  TaskManager: { group: 'memoryTask', effect: 'task' },
  delegate_task: { group: 'memoryTask', effect: 'task' },
  // 旧名保留：历史会话的 tool_calls 里存的是 spawn_task（2026-08-08 改名前），
  // 回看旧会话时仍要能归到同一审批组。
  spawn_task: { group: 'memoryTask', effect: 'task' },
  steer_task: { group: 'memoryTask', effect: 'task' },
  cancel_task: { group: 'memoryTask', effect: 'task' },
  task_status: { group: 'memoryTask', effect: 'task' },

  WebSearch: { group: 'network', effect: 'webSearch' },
  ExternalSearch: { group: 'network', effect: 'webSearch' },
  WebFetch: { group: 'network', effect: 'webFetch' },

  AskUserQuestion: { group: 'assist', effect: 'askUser' },
  Skill: { group: 'assist', effect: 'useSkill' },
  ToolSearch: { group: 'assist', effect: 'findTool' },
  recommend_capability: { group: 'assist', effect: 'findTool' },
};

interface ToolConsentSummary {
  /** 已翻译的分组，按 TOOL_CONSENT_GROUP_ORDER 排；每组内 effect 去重、保留首次出现顺序。 */
  groups: Array<{ group: ToolConsentGroup; effects: ToolConsentEffect[] }>;
  /** 映射表里没有的工具原名——调用方必须显示，不许吞。 */
  unmapped: string[];
}

export function groupToolsForConsent(tools: readonly string[]): ToolConsentSummary {
  const byGroup = new Map<ToolConsentGroup, ToolConsentEffect[]>();
  const unmapped: string[] = [];

  for (const tool of tools) {
    const entry = TOOL_CONSENT_MAP[tool];
    if (!entry) {
      if (!unmapped.includes(tool)) unmapped.push(tool);
      continue;
    }
    const effects = byGroup.get(entry.group) ?? [];
    if (!effects.includes(entry.effect)) effects.push(entry.effect);
    byGroup.set(entry.group, effects);
  }

  return {
    groups: TOOL_CONSENT_GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({
      group,
      effects: byGroup.get(group) ?? [],
    })),
    unmapped,
  };
}

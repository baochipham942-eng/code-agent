// ============================================================================
// toolProfiles —— dynamic-workflow 子 agent 工具分档策略（P2-C）
//
// 子 agent（agent() 无 schema 的 full-agent 路径）默认只读+调研；迁移/审计/重构场景按需放开
// 写能力。分三档而非一刀切，权限/安全可控：
//   - readonly：WebSearch/WebFetch/Read/Glob/Grep（默认）
//   - edit    ：readonly + Edit/Write（可改文件）
//   - full    ：edit + Bash（可跑命令）
// 模型脚本经 agent(prompt, { tools: 'edit' }) 按 agent 选档。写能力档（edit/full）会触发
// 并行写护栏（多个写 agent 共享同一工作树时告警；真 worktree 隔离后续支持）。
// 工具名须与 protocol registry 注册名精确一致（PascalCase）。
// ============================================================================

export type ToolProfile = 'readonly' | 'edit' | 'full';

const READONLY = ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'];
const EDIT = [...READONLY, 'Edit', 'Write'];
const FULL = [...EDIT, 'Bash'];

export const WORKFLOW_TOOL_PROFILES: Record<ToolProfile, string[]> = {
  readonly: READONLY,
  edit: EDIT,
  full: FULL,
};

/** 会修改工作树 / 执行命令的工具，用于并行写护栏判定。 */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'Bash']);

/** 把 agent({tools}) 的档名解析成工具白名单 + 是否写能力。缺省 = readonly；未知档名抛错。 */
export function resolveToolProfile(profile?: string): { tools: string[]; writeCapable: boolean } {
  const key = (profile ?? 'readonly') as ToolProfile;
  const tools = WORKFLOW_TOOL_PROFILES[key];
  if (!tools) {
    throw new Error(`未知的 workflow 工具档: ${profile}（合法值: readonly | edit | full）`);
  }
  return { tools, writeCapable: tools.some((t) => WRITE_TOOLS.has(t)) };
}

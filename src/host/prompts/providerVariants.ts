// ============================================================================
// Prompt provider 变体（roadmap 2.4）— 按 provider 家族追加纪律段落
// ============================================================================
// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) —
// session/prompt/anthropic.txt（Git 安全）与 gpt.txt（自治与坚持）的
// 家族差异化策略。Neo 适配：不 fork 整份主提示词，而是 base + 家族 addendum
// （additive，控 eval 回退面；base 对所有家族保持不变）。
//
// 家族划分依据（报告④）：不同模型失败模式不同——
// - Claude 系：话多、git 误操作（amend/全量 add）→ 补 Git 安全纪律
// - GPT/国产系（kimi/deepseek/zhipu/xiaomi/qwen/minimax…）：易过早停、
//   只给方案不动手 → 补自治与坚持纪律
// ============================================================================

export type ProviderFamily = 'claude' | 'autonomous' | 'default';

/**
 * 变体段落标记：幂等守卫 + telemetry 肉眼可辨。
 * 用不透明 HTML 注释哨兵而非可见标题——避免 custom/base prompt 恰好包含
 * 同名标题时变体被整体禁用（Codex R1 MED）。
 */
export const PROVIDER_VARIANT_MARKER = '<!-- code-agent-provider-variant:v1 -->';

const CLAUDE_PROVIDERS = new Set(['anthropic', 'claude']);
const AUTONOMOUS_PROVIDERS = new Set([
  'openai',
  'gpt',
  'azure-openai',
  'moonshot',
  'kimi',
  'deepseek',
  'zhipu',
  'xiaomi',
  'qwen',
  'alibaba',
  'minimax',
  'baidu',
  'volcengine',
  'longcat',
  'groq',
]);

/**
 * eval A/B 对照开关（audit D-R3）：除控制注入外，eval run metadata 也用它
 * 记录 variant 臂（environment.providerVariantArm），两臂结果才可归因。
 */
export function isProviderVariantDisabled(): boolean {
  const flag = process.env.CODE_AGENT_DISABLE_PROVIDER_VARIANT?.trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

/**
 * 解析 provider 家族。provider 名优先；自定义中转（custom-*）等未知 provider
 * 回退看 model 名前缀。两者都认不出 → 'default'（不加变体段落）。
 */
export function resolveProviderFamily(provider?: string, model?: string): ProviderFamily {
  const p = (provider || '').toLowerCase();
  if (CLAUDE_PROVIDERS.has(p)) return 'claude';
  if (AUTONOMOUS_PROVIDERS.has(p)) return 'autonomous';

  // owner 前缀模型 id（openrouter 等中转格式 "anthropic/claude-x"、"openai/gpt-x"）：
  // 取最后一段再匹配（Codex R1 MED）
  const rawModel = (model || '').toLowerCase();
  const m = rawModel.includes('/') ? rawModel.slice(rawModel.lastIndexOf('/') + 1) : rawModel;
  if (m.startsWith('claude')) return 'claude';
  if (/^(gpt|o\d|kimi|deepseek|glm|qwen|mimo|minimax|ernie|doubao|longcat)/.test(m)) {
    return 'autonomous';
  }

  // 自定义中转 provider（custom-*）按关键词识别家族
  if (p.includes('claude') || p.includes('anthropic')) return 'claude';
  if (/(openai|gpt|kimi|moonshot|deepseek|zhipu|xiaomi|qwen|minimax|baidu|doubao|longcat)/.test(p)) {
    return 'autonomous';
  }
  return 'default';
}

// Git 安全纪律（Claude 系）— adapted from MiMoCode anthropic.txt
const CLAUDE_VARIANT_SECTION = `

${PROVIDER_VARIANT_MARKER}
## Provider-family discipline (claude family)

# Git safety
- NEVER update the git config
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, destroying prior work. After hook failure: fix the issue, re-stage, and create a NEW commit.
- When staging files, prefer adding specific files by name rather than "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries.
- Never use git commands with the -i flag (git rebase -i, git add -i) since they require interactive input which is not supported.
- Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative.
- NEVER commit changes unless the user explicitly asks you to.

# Output discipline
- Keep non-tool output concise. Lead with the outcome; supporting detail after. Do not narrate every tool call or restate file contents the user can read.`;

// 自治与坚持纪律（GPT/国产系）— adapted from MiMoCode gpt.txt
const AUTONOMOUS_VARIANT_SECTION = `

${PROVIDER_VARIANT_MARKER}
## Provider-family discipline (autonomous family)

# Autonomy and persistence
- Unless the user explicitly asks for a plan, asks a question about the code, or is brainstorming, assume the user wants you to make code changes or run tools to solve the problem. It's bad to only output a proposed solution in a message — go ahead and actually implement the change. If you encounter challenges or blockers, attempt to resolve them yourself.
- Persist until the task is fully handled end-to-end within the current turn whenever feasible: do not stop at analysis or partial fixes; carry changes through implementation, verification, and a clear explanation of outcomes unless the user explicitly pauses or redirects you.
- Do not end your turn with a question you can answer yourself by reading code or running a tool.
- If you notice unexpected changes in the worktree that you did not make, continue with your task. NEVER revert, undo, or modify changes you did not make unless the user explicitly asks — multiple agents or the user may be working in the same codebase concurrently.`;

export interface ApplyProviderVariantOptions {
  /**
   * base 是用户自带 prompt（项目 SYSTEM.md / agent 路由自带）时为 true，跳过注入。
   * 统一语义（audit D-Y2）：变体纪律针对默认主提示词的失败模式调校，
   * 注到用户自定义 base 上既可能与其指令冲突，也破坏 A/B 归因前提——
   * 与 orchestrator 对 agent 自带 prompt 的跳过、FULL_SYSTEM.md 短路保持一致。
   */
  customBase?: boolean;
}

/**
 * 给系统提示词追加家族变体段落。幂等（已含标记则原样返回）；
 * 'default' 家族不追加；用户自带 base（opts.customBase）不追加。
 */
export function applyProviderVariant(
  systemPrompt: string,
  provider?: string,
  model?: string,
  opts?: ApplyProviderVariantOptions,
): string {
  if (opts?.customBase) {
    return systemPrompt;
  }
  if (isProviderVariantDisabled()) {
    return systemPrompt;
  }
  if (systemPrompt.includes(PROVIDER_VARIANT_MARKER)) {
    return systemPrompt;
  }
  const family = resolveProviderFamily(provider, model);
  if (family === 'claude') return systemPrompt + CLAUDE_VARIANT_SECTION;
  if (family === 'autonomous') return systemPrompt + AUTONOMOUS_VARIANT_SECTION;
  return systemPrompt;
}

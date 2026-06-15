/**
 * Composer 快捷键的纯决策逻辑（T2）。
 *
 * 背景：composer 作用域的 `slashMenu` 默认绑定裸键 `/`，由全局 document keydown
 * 监听触发。此前无焦点门控，导致 `/` 在任何输入框都被 preventDefault、打不出，
 * 且打开菜单时会覆盖已输入文本。这里把"是否拦截""如何取值"抽成纯函数便于测试。
 */

export interface BareComposerShortcutContext {
  /** composer 输入框当前是否聚焦 */
  composerFocused: boolean;
  /** 输入框当前文本 */
  value: string;
}

/**
 * 裸单字符快捷键（如默认 `/`）是否应作为命令拦截。
 * 仅在 composer 聚焦且输入为空时拦截；否则返回 false，让字符正常输入
 * （URL/路径/正则/中途输入不被吞）。
 *
 * 注意：只在空输入时开菜单。若输入已有文本（即使光标在行首），不拦截——
 * 否则会出现"菜单打开但输入框不是 slash 命令"的不一致状态
 * （codex round-2 审计发现：选 command 会拿现有文本做 base、选 skill 删不到尾部 slash）。
 */
export function shouldTriggerBareComposerShortcut(ctx: BareComposerShortcutContext): boolean {
  if (!ctx.composerFocused) return false;
  if (ctx.value.length > 0) return false;
  return true;
}

/**
 * 打开 slash 菜单时计算 composer 的新值：
 * 已以 `/` 开头则保持；空输入插入 `/`；非空且非 `/` 开头则不覆盖已输入文本。
 */
export function computeSlashMenuValue(current: string): string {
  if (current.startsWith('/')) return current;
  if (current.length === 0) return '/';
  return current;
}

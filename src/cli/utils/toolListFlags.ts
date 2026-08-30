// ============================================================================
// --tools / --disallowed-tools 逗号分隔列表解析
// ============================================================================

/**
 * 解析 `--tools` / `--disallowed-tools` 的逗号分隔工具名列表。
 *
 * - 大小写不敏感由下游 run policy（tools/runToolPolicy.ts）统一处理，这里只做 split/trim/去重；
 * - 支持 `skill:<name>` 前缀（技能在工具面注册为 `skill:<name>` 延迟工具，原样透传即可）；
 * - 未传 flag 或解析后为空 → undefined：保证无 flag 时行为与此前逐字节一致。
 */
export function parseToolNameListFlag(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const names = Array.from(new Set(
    value.split(',').map((entry) => entry.trim()).filter(Boolean),
  ));
  return names.length > 0 ? names : undefined;
}

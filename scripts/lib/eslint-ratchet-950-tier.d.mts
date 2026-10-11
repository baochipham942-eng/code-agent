/** 950-tier 阈值：有效行 ≥ 此值的非白名单文件进入早 warn 名单。 */
export const NINE_FIFTY_TIER_MIN_LINES: number;
export interface MaxLinesCount {
  file: string;
  lines: number;
}
/** eslint JSON 报告 → max-lines 计数列表（行数降序、同数按路径）。入参 defensively 当 unknown 处理。 */
export function parseMaxLinesCounts(report: unknown): MaxLinesCount[];
/** flat config 数组 → `max-lines: 'off'` 条目的 files 并集（God File 白名单）。 */
export function extractMaxLinesOffWhitelist(configs: unknown): string[];
/** flat-config glob（支持 `**` / `*`）→ 锚定 RegExp。 */
export function flatConfigGlobToRegExp(pattern: string): RegExp;
/** 过滤 + 排序 + 输出行构造；不 spawn、不落盘。 */
export function buildNineFiftyTier(input: {
  counts: unknown;
  whitelistPatterns: unknown;
  repoRoot?: string;
}): { entries: MaxLinesCount[]; outputLines: string[] };

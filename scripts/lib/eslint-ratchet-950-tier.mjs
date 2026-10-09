// ============================================================================
// eslint-ratchet 950-tier 纯逻辑——解析 / 白名单匹配 / 输出行构造
// ============================================================================
// 供 scripts/eslint-ratchet.mjs（生产）与 tests/scripts/eslintRatchet950Tier.test.ts
// 共用。只做纯数据变换：不 spawn 进程、不读文件，测试不需要夹具目录。
// tier 语义：有效行 ≥ NINE_FIFTY_TIER_MIN_LINES 且不在 God File 白名单内的文件，
// 只报告、不计数、不影响退出码（见 eslint-ratchet.mjs 里的接入注释）。

export const NINE_FIFTY_TIER_MIN_LINES = 950;

/**
 * 从 `eslint --format json` 报告里提取 max-lines 计数。
 * 只认 message 文本里的行数（`File has too many lines (N). ...`），
 * 其余规则的 message 一律忽略；按行数降序、同数按路径字典序。
 */
export function parseMaxLinesCounts(report) {
  const counts = [];
  for (const fileResult of Array.isArray(report) ? report : []) {
    if (!fileResult || typeof fileResult !== 'object' || !Array.isArray(fileResult.messages)) continue;
    for (const message of fileResult.messages) {
      if (!message || message.ruleId !== 'max-lines') continue;
      const match = /File has too many lines \((\d+)\)/.exec(String(message.message ?? ''));
      if (match) counts.push({ file: String(fileResult.filePath ?? ''), lines: Number(match[1]) });
    }
  }
  return counts.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
}

/**
 * flat config 数组里 `rules['max-lines'] === 'off'` 的条目的 files 并集——
 * 即 eslint.config.js 的 God File 历史白名单（按配置语义取，不按注释文本猜）。
 */
export function extractMaxLinesOffWhitelist(configs) {
  const patterns = [];
  for (const config of Array.isArray(configs) ? configs : []) {
    if (!config || typeof config !== 'object' || config.rules?.['max-lines'] !== 'off') continue;
    for (const pattern of Array.isArray(config.files) ? config.files : []) {
      if (typeof pattern === 'string') patterns.push(pattern);
    }
  }
  return patterns;
}

/** flat-config glob（支持 `**` 跨段与 `*` 段内）→ 锚定 RegExp；其余字符按字面量。 */
export function flatConfigGlobToRegExp(pattern) {
  const source = String(pattern)
    .split('**')
    // 先转义再换 *：`*` 不进转义字符类，否则转义成 `\*` 后二次替换会拼出坏模式
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/**
 * 构造 950-tier 报告：过滤（≥ 阈值、不在白名单）、排序、生成输出行。
 * filePath 允许是绝对路径（eslint JSON 即如此），repoRoot 存在时剥掉前缀取仓内相对路径。
 */
export function buildNineFiftyTier({ counts, whitelistPatterns, repoRoot = '' }) {
  const whitelist = (Array.isArray(whitelistPatterns) ? whitelistPatterns : []).map(flatConfigGlobToRegExp);
  const normalizedRoot = repoRoot ? `${String(repoRoot).split('\\').join('/')}/` : '';
  const entries = [];
  for (const count of Array.isArray(counts) ? counts : []) {
    if (!count || typeof count !== 'object' || typeof count.lines !== 'number'
      || !Number.isFinite(count.lines) || count.lines < NINE_FIFTY_TIER_MIN_LINES) continue;
    const normalized = String(count.file ?? '').split('\\').join('/');
    const relative = normalizedRoot && normalized.startsWith(normalizedRoot)
      ? normalized.slice(normalizedRoot.length)
      : normalized;
    if (whitelist.some((pattern) => pattern.test(relative))) continue;
    entries.push({ file: relative, lines: count.lines });
  }
  entries.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  const outputLines = [
    `[eslint-ratchet] ⚠ 950-tier：${entries.length} 个文件 ≥${NINE_FIFTY_TIER_MIN_LINES} 有效行`
    + '（approaching the limit; the next person to edit this file will turn red）：',
    ...entries.map((entry) => `  ${entry.file} (${entry.lines})`),
  ];
  return { entries, outputLines };
}

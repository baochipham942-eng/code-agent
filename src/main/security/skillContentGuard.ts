// ============================================================================
// SkillContentGuard — skill 草稿入库前的内容安全扫描（fail-closed）
// 反超 Hermes Agent：Hermes 的 agent-created skill 默认不扫描（fail-open），
// 这里在草稿确认入库前过一道扫描，命中 critical 危险命令或高置信密钥则拒绝入库。
// 复用既有安全件：commandSafety.validateCommand + sensitiveDetector，不另造威胁正则。
//
// 阻断阈值刻意保守（只拦 critical / high-confidence），避免误伤正常 skill：
//   - critical 危险命令（rm -rf /、mkfs、dd to /dev、fork bomb、反弹 shell 等）
//   - 高置信嵌入密钥（API key / 私钥等明文写进 skill）
// medium/low 风险只记录不拦，正常 skill 几乎不会命中。
// ============================================================================

import { validateCommand } from './commandSafety';
import { getSensitiveDetector } from './sensitiveDetector';

export interface SkillGuardFinding {
  kind: 'dangerous_command' | 'embedded_secret';
  /** 给用户看的中文说明 */
  detail: string;
}

export interface SkillGuardResult {
  verdict: 'pass' | 'block';
  findings: SkillGuardFinding[];
}

/**
 * 从 Markdown 中抽出"代码"片段：fenced code block 的每一行 + 行内反引号 code span。
 * 危险命令通常出现在这些片段里，按片段扫描可大幅降低对正文散文的误判。
 */
export function extractCodeSegments(markdown: string): string[] {
  const segments: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const trimmed = line.trim();
      if (trimmed) segments.push(trimmed);
      continue;
    }
    const inlineSpans = line.match(/`([^`]+)`/g);
    if (inlineSpans) {
      for (const span of inlineSpans) {
        const inner = span.replace(/`/g, '').trim();
        if (inner) segments.push(inner);
      }
    }
  }
  return segments;
}

/**
 * 扫描一份 SKILL.md 内容。返回 block = 命中需拒绝入库的风险。
 */
// 已知 shell 名（用于"管道进 shell"匹配；刻意不含 ssh —— ssh 不以这些前缀开头，不会误命中）
const SHELL_TOKEN = '(?:ba|z|da|c|k|tc|a|fi)?sh';

// 混淆 / RCE / 外泄签名：validateCommand 不一定覆盖的"下载并执行 / 反弹 shell"等模式。
// 在归一化（去引号/反斜杠/IFS 后）的文本上匹配，正常 skill 里几乎不会出现，命中即拦。
const OBFUSCATION_PATTERNS: Array<{ re: RegExp; flag: string }> = [
  // 任意内容管道进 shell（不限 decoder：curl|sh、base64 -d|sh、xxd|sh、echo|sh 都覆盖）
  { re: new RegExp(`\\|\\s*(sudo\\s+)?${SHELL_TOKEN}\\b`, 'i'), flag: 'pipe_to_shell' },
  // eval 动态执行（命令替换 / 反引号 / 子表达式）
  { re: /\beval\b[^\n]*[$`(]/i, flag: 'eval_dynamic' },
  // 反弹 shell：/dev/tcp 重定向
  { re: new RegExp(`\\b${SHELL_TOKEN}\\b[^\\n]*\\/dev\\/tcp\\/`, 'i'), flag: 'reverse_shell_devtcp' },
  // netcat 反弹 shell
  { re: /\bnc\b[^\n]*-e\s*\/(bin|usr)\/[a-z/]*sh/i, flag: 'netcat_reverse_shell' },
  // 命令替换里下载：$(curl ...) / `wget ...`
  { re: /[$`]\(?\s*(curl|wget|fetch)\b[^)`\n]*\)?/i, flag: 'cmdsubst_download' },
];

/**
 * 扫描前 shell 语义归一化：把常见的"拆词/混淆命令名"还原，防止绕过命令检测。
 * 不追求完整 shell 解析，但覆盖 Codex 复审点出的原生绕过面：
 *   - NFKC 折叠全角/兼容字符：ｒｍ → rm
 *   - 去零宽字符（ZWSP/ZWNJ/ZWJ/WJ/BOM）：拆在命令名里的零宽字符还原
 *   - ${IFS}/$IFS 等高危分隔符当空白：rm${IFS}-rf${IFS}/ → rm -rf /
 *   - 反斜杠续行合并：rm -rf \\\n / → rm -rf /
 *   - 去引号/反斜杠拼接：'rm' / r''m / r\m → rm
 */
export function normalizeForScan(content: string): string {
  return content
    .normalize('NFKC')
    .replace(new RegExp('[\\u200B-\\u200D\\u2060\\uFEFF]', 'g'), '')
    .replace(/\$\{IFS[^}]*\}|\$IFS\b/g, ' ')
    .replace(/\\\r?\n[ \t]*/g, ' ')
    .replace(/[\\'"]/g, '');
}

export function scanSkillContent(content: string): SkillGuardResult {
  const findings: SkillGuardFinding[] = [];
  const normalized = normalizeForScan(content);

  // 1) 危险命令：对【全文】逐行跑 validateCommand（不止代码块——skill 散文本身就是
  //    agent 会照着执行的指令，藏在散文里的危险命令同样要拦），命中 critical 即拦。
  const seen = new Set<string>();
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    const result = validateCommand(line);
    if (result.riskLevel === 'critical') {
      findings.push({
        kind: 'dangerous_command',
        detail: `危险命令（${result.securityFlags.join(',') || 'critical'}）：${line.slice(0, 80)}`,
      });
    }
  }

  // 2) 混淆 / RCE / 外泄签名（对归一化后的全文匹配）
  for (const { re, flag } of OBFUSCATION_PATTERNS) {
    const m = normalized.match(re);
    if (m) {
      findings.push({ kind: 'dangerous_command', detail: `可疑混淆/远程执行（${flag}）：${m[0].slice(0, 80)}` });
    }
  }

  // 3) 嵌入密钥：高置信的明文密钥/私钥不应写进 skill
  const detection = getSensitiveDetector().detect(content);
  for (const match of detection.matches) {
    if (match.confidence === 'high') {
      findings.push({
        kind: 'embedded_secret',
        detail: `疑似明文密钥（${match.type}）：${match.masked}`,
      });
    }
  }

  return { verdict: findings.length > 0 ? 'block' : 'pass', findings };
}

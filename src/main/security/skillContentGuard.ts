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
// 混淆 / RCE / 外泄签名：validateCommand 不一定覆盖的"下载并执行 / 反弹 shell"等模式。
// 这些在正常 skill 里几乎不会出现，命中即拦（高信号低误伤）。
const OBFUSCATION_PATTERNS: Array<{ re: RegExp; flag: string }> = [
  // 下载后直接管道进 shell：curl/wget/fetch ... | sh|bash|zsh
  { re: /\b(curl|wget|fetch)\b[^\n]*\|\s*(sudo\s+)?\w*sh\b/i, flag: 'download_pipe_shell' },
  // base64 解码后管道进 shell
  { re: /\bbase64\b[^\n]*-{0,2}d(ecode)?\b[^\n]*\|\s*(sudo\s+)?\w*sh\b/i, flag: 'base64_pipe_shell' },
  // 任意 echo/printf 解码管道进 shell（eval 风格）
  { re: /\beval\b[^\n]*\$\(/i, flag: 'eval_cmd_subst' },
  // 反弹 shell：/dev/tcp 重定向
  { re: /\b(ba|z)?sh\b[^\n]*\/dev\/tcp\//i, flag: 'reverse_shell_devtcp' },
  // netcat 反弹 shell
  { re: /\bnc\b[^\n]*-e\s*\/(bin|usr)\/[a-z/]*sh/i, flag: 'netcat_reverse_shell' },
  // 命令替换里下载：$(curl ...) / `wget ...`
  { re: /[$`]\(?\s*(curl|wget|fetch)\b[^)`\n]*\)?/i, flag: 'cmdsubst_download' },
];

/**
 * 扫描前归一化：把反斜杠续行（`\` + 换行）合并成单行，防止把危险命令拆行绕过扫描。
 */
export function normalizeForScan(content: string): string {
  return content.replace(/\\\r?\n[ \t]*/g, ' ');
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

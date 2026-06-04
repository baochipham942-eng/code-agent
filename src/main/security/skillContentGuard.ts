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
export function scanSkillContent(content: string): SkillGuardResult {
  const findings: SkillGuardFinding[] = [];

  // 1) 危险命令：只在代码片段上跑 validateCommand，命中 critical 才拦
  for (const segment of extractCodeSegments(content)) {
    const result = validateCommand(segment);
    if (result.riskLevel === 'critical') {
      findings.push({
        kind: 'dangerous_command',
        detail: `危险命令（${result.securityFlags.join(',') || 'critical'}）：${segment.slice(0, 80)}`,
      });
    }
  }

  // 2) 嵌入密钥：高置信的明文密钥/私钥不应写进 skill
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

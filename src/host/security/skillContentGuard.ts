// ============================================================================
// SkillContentGuard — skill 草稿入库前的内容安全扫描（fail-closed）
// 反超 Hermes Agent：Hermes 的 agent-created skill 默认不扫描（fail-open），
// 这里在草稿确认入库前过一道扫描，命中 critical 危险命令或高置信密钥则拒绝入库。
// 复用既有安全件：commandSafety.validateCommand + sensitiveDetector，不另造威胁正则。
//
// 阻断阈值刻意保守（只拦 critical / high-confidence），避免误伤正常 skill：
//   - critical 危险命令（rm -rf /、mkfs、dd to /dev、fork bomb、反弹 shell 等）→ block
//   - 高置信嵌入密钥（API key / 私钥等明文写进 skill）→ block
// low/medium/high 且带 securityFlags 的命令、以及 medium 置信密钥 → caution（不拦草稿入库）。
// safe 或没有 securityFlags 的行是噪声，不进 caution。
// ============================================================================

import { validateCommand } from './commandSafety';
import { getSensitiveDetector } from './sensitiveDetector';
import { canonicalizeCommand } from './canonicalizeCommand';
import {
  OBFUSCATION_PATTERNS,
  SSH_PRIVATE_KEY_PATH,
  SSH_PRIVATE_KEY_READ_VERB,
} from './patterns/injectionPatterns';
import { stripSpecialTokenLiterals } from './untrustedContentBoundary';

export interface SkillGuardFinding {
  kind: 'dangerous_command' | 'embedded_secret';
  /** 给用户看的中文说明 */
  detail: string;
  /** caution 命中的规则 id。block 命中不带此字段，保持既有 finding 形状。 */
  ruleId?: string;
  /** caution 命中的一行摘要：命令行截断 80 字后经 maskSensitiveData；密钥用检测器的 masked。 */
  snippet?: string;
}

/**
 * 内容扫描规则版本。扫描规则（危险命令/密钥/混淆签名等）加严时 +1。
 * 2：新增 caution 档（low/medium/high 带 flag 的命令、medium 置信密钥）。
 * 安装记录里 scanner.version 低于该值的已启用插件会在宿主启动与 enablePlugin 时重扫
 * （src/host/skills/marketplace/installedPluginRescan.ts）。
 */
export const SKILL_GUARD_VERSION = 2;

export interface SkillGuardResult {
  verdict: 'pass' | 'caution' | 'block';
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
 * maskSensitiveData 就是 getSensitiveDetector().maskAll。部分 guard 测试把检测器
 * 换成只含 detect 的替身；缺 maskAll 时退回截断原文，避免那些替身把扫描打崩。
 */
function maskScanSnippet(line: string): string {
  const truncated = line.slice(0, 80);
  const detector: { maskAll?: (text: string) => string } = getSensitiveDetector();
  return typeof detector.maskAll === 'function' ? detector.maskAll(truncated) : truncated;
}

// 命令位置的动态构造：命令名是变量/命令替换/参数展开/ANSI-C quote（如 $a、$(...)、${cmd/x/r}、$'\x72'）时，
// 静态扫描无法判定它最终会展开成什么，对 skill 入库一律 fail-closed。
// 注：反引号命令替换不在此列（markdown 行首内联代码会大量误伤）；反引号下载由 cmdsubst 签名覆盖。
const DYNAMIC_CMD_START = /^(\$\(|\$\{|\$'|\$[A-Za-z_])/;
const CMD_SEPARATORS = /[;&|\n]+/;

// 透明包装前缀：这些命令本身无害，真正要执行的命令名在其后。判断动态命令名前需把它们
// （及其带参选项）剥掉，否则 `sudo $a -rf /` 会因段首是 sudo 而漏判。value = 需要消费下一个
// token 作为参数的短选项集合。
const COMMAND_WRAPPERS: Record<string, Set<string>> = {
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
  setsid: new Set(),
  doas: new Set(['-u', '-C']),
  sudo: new Set(['-u', '-g', '-C', '-p', '-r', '-t', '-h', '-U', '-R', '-T']),
  env: new Set(['-u', '-S', '-C', '-P']),
  nice: new Set(['-n']),
  time: new Set(['-o', '-f']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k']), // 另含一个位置参数 DURATION，单独处理
};

/** 提取一个命令段真正的"命令名"token（剥离前置赋值 + 透明 wrapper 及其选项），判断是否动态。 */
export function commandWordIsDynamic(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i])) i++; // 前置环境赋值
  let guard = 0;
  while (i < tokens.length && guard++ < 20) {
    const word = tokens[i].toLowerCase();
    const argOpts = COMMAND_WRAPPERS[word];
    if (argOpts === undefined) {
      return DYNAMIC_CMD_START.test(tokens[i]); // 第一个非 wrapper token = 命令名
    }
    i++; // 消费 wrapper 名
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const opt = tokens[i].split('=')[0];
      const inlineArg = tokens[i].includes('=');
      i++;
      if (argOpts.has(opt) && !inlineArg) i++; // 消费该选项的参数
    }
    if (word === 'env') {
      while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i])) i++; // env NAME=val
    }
    if (word === 'timeout' && i < tokens.length && !DYNAMIC_CMD_START.test(tokens[i])) {
      i++; // timeout DURATION 位置参数
    }
  }
  return false;
}

/** 检测是否存在"动态命令名"（命令位置出现 $.../${...}/$(...)/ANSI-C，含 wrapper 前缀后的命令名）。 */
export function findDynamicCommandName(normalized: string): string | null {
  for (const rawSeg of normalized.split(CMD_SEPARATORS)) {
    const seg = rawSeg.trim();
    if (seg && commandWordIsDynamic(seg)) return seg.slice(0, 60);
  }
  return null;
}

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
  const logicalLines = content.replace(/\\\r?\n[ \t]*/g, ' ').split(/\r?\n/);
  return logicalLines.map((line) => canonicalizeCommand(line).command).join('\n');
}

/**
 * 扫描一份 SKILL.md 内容。block = 拒绝入库；caution = 披露后按来源策略处理；pass = 无命中。
 * 任一 block finding 使总判定为 block（caution 仍可并列列出，不能把 block 盖成 caution）。
 */
export function scanSkillContent(content: string): SkillGuardResult {
  const blockFindings: SkillGuardFinding[] = [];
  const cautionFindings: SkillGuardFinding[] = [];
  const { found: specialTokens } = stripSpecialTokenLiterals(content);
  if (specialTokens.length > 0) {
    blockFindings.push({
      kind: 'dangerous_command',
      detail: `模型控制 token：${[...new Set(specialTokens)].slice(0, 3).join(', ')}`,
    });
  }
  const normalized = normalizeForScan(content);

  // fenced / inline code 中无法可靠拆词的 shell 片段不可进入 skill。Markdown 的
  // 反引号标记已由 extractCodeSegments 剥掉，不会把普通 inline code 标记误判成命令替换。
  for (const segment of new Set(extractCodeSegments(content))) {
    const canonical = canonicalizeCommand(segment);
    const firstWord = segment.trim().split(/\s+/, 1)[0] ?? '';
    const dynamicOnlyInArguments = canonical.failureReason?.startsWith('dynamic command substitution')
      && !commandWordIsDynamic(segment)
      && !firstWord.includes('`');
    if (canonical.parsingFailed && !dynamicOnlyInArguments) {
      blockFindings.push({
        kind: 'dangerous_command',
        detail: `命令无法静态解析，已拒绝（${canonical.failureReason ?? 'parse failure'}）：${segment.slice(0, 80)}`,
      });
    }
  }

  // 1) 危险命令：对【全文】逐行跑 validateCommand（不止代码块——skill 散文本身就是
  //    agent 会照着执行的指令，藏在散文里的危险命令同样要拦）。
  //    critical → block；low/medium/high 且至少有一个 securityFlags → caution。
  const seen = new Set<string>();
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    const result = validateCommand(line);
    if (result.riskLevel === 'critical') {
      blockFindings.push({
        kind: 'dangerous_command',
        detail: `危险命令（${result.securityFlags.join(',') || 'critical'}）：${line.slice(0, 80)}`,
      });
    } else if (
      (result.riskLevel === 'low' || result.riskLevel === 'medium' || result.riskLevel === 'high')
      && result.securityFlags.length > 0
    ) {
      const ruleId = result.securityFlags[0];
      if (ruleId) {
        const snippet = maskScanSnippet(line);
        cautionFindings.push({
          kind: 'dangerous_command',
          detail: `需留意的命令（${ruleId}）：${snippet}`,
          ruleId,
          snippet,
        });
      }
    }
    if (SSH_PRIVATE_KEY_PATH.test(line) && SSH_PRIVATE_KEY_READ_VERB.test(line)) {
      blockFindings.push({
        kind: 'dangerous_command',
        detail: `SSH 私钥读取规则：${line.slice(0, 80)}`,
      });
    }
  }

  // 2) 混淆 / RCE / 外泄签名（对归一化后的全文匹配；正则唯一源在 injectionPatterns）
  for (const { pattern, flag } of OBFUSCATION_PATTERNS) {
    pattern.lastIndex = 0;
    const m = normalized.match(pattern);
    if (m) {
      blockFindings.push({ kind: 'dangerous_command', detail: `可疑混淆/远程执行（${flag}）：${m[0].slice(0, 80)}` });
    }
  }

  // 2.5) 动态命令名：命令位置是变量/替换/展开 → 静态不可判定，fail-closed
  const dynamic = findDynamicCommandName(normalized);
  if (dynamic) {
    blockFindings.push({ kind: 'dangerous_command', detail: `命令名为动态构造，无法静态判定，已拒绝：${dynamic}` });
  }

  // 3) 嵌入密钥：高置信 → block；medium 置信 → caution，snippet 只用检测器的 masked。
  const detection = getSensitiveDetector().detect(content);
  for (const match of detection.matches) {
    if (match.confidence === 'high') {
      blockFindings.push({
        kind: 'embedded_secret',
        detail: `疑似明文密钥（${match.type}）：${match.masked}`,
      });
    } else if (match.confidence === 'medium') {
      cautionFindings.push({
        kind: 'embedded_secret',
        detail: `疑似明文密钥（${match.type}）：${match.masked}`,
        ruleId: `embedded_secret_medium:${match.type}`,
        snippet: match.masked,
      });
    }
  }

  const findings = [...blockFindings, ...cautionFindings];
  const verdict = blockFindings.length > 0 ? 'block' : cautionFindings.length > 0 ? 'caution' : 'pass';
  return { verdict, findings };
}

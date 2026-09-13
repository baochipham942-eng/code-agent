// ============================================================================
// Prompt Injection Detection Patterns
// ============================================================================

export type InjectionAttackCategory =
  | 'prompt_injection'
  | 'jailbreak_attempt'
  | 'data_exfiltration'
  | 'instruction_override'
  | 'sensitive_data'
  | 'obfuscation_rce';

/** lenient = tool results; strict = memory writes + skill install (superset of lenient). */
export type InjectionPatternScope = 'lenient' | 'strict';

export interface InjectionPattern {
  pattern: RegExp;
  type: InjectionAttackCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  /**
   * Omit or `lenient`: applies to tool results and every stricter consumer.
   * `strict`: memory writes and skill installation only.
   */
  scope?: InjectionPatternScope;
  /** Stable id for skillContentGuard obfuscation findings. */
  flag?: string;
}

export function patternAppliesToScope(
  pattern: InjectionPattern,
  scope: InjectionPatternScope,
): boolean {
  if (scope === 'strict') return true;
  return (pattern.scope ?? 'lenient') === 'lenient';
}

const SHELL_TOKEN = '(?:ba|z|da|c|k|tc|a|fi)?sh';

/**
 * Obfuscation / RCE signatures — unique regex source, consumed by
 * INJECTION_PATTERNS (strict scope) and skillContentGuard.
 */
export const OBFUSCATION_PATTERNS: Array<InjectionPattern & { flag: string }> = [
  {
    pattern: new RegExp(
      `\\|\\s*(sudo\\s+)?(env\\s+|busybox\\s+)?([\\w./-]*/)?(?:${SHELL_TOKEN}|pwsh|powershell)\\b`,
      'i',
    ),
    type: 'obfuscation_rce',
    severity: 'critical',
    description: '管道将内容送入 shell 解释器',
    scope: 'strict',
    flag: 'pipe_to_shell',
  },
  {
    pattern: /\beval\b[^\n]*[$`(]/i,
    type: 'obfuscation_rce',
    severity: 'critical',
    description: 'eval 动态执行',
    scope: 'strict',
    flag: 'eval_dynamic',
  },
  {
    pattern: new RegExp(`\\b${SHELL_TOKEN}\\b[^\\n]*\\/dev\\/tcp\\/`, 'i'),
    type: 'obfuscation_rce',
    severity: 'critical',
    description: '通过 /dev/tcp 反弹 shell',
    scope: 'strict',
    flag: 'reverse_shell_devtcp',
  },
  {
    pattern: /\bnc\b[^\n]*-e\s*\/(bin|usr)\/[a-z/]*sh/i,
    type: 'obfuscation_rce',
    severity: 'critical',
    description: 'netcat 反弹 shell',
    scope: 'strict',
    flag: 'netcat_reverse_shell',
  },
  {
    pattern: /[$`]\(?\s*(curl|wget|fetch)\b[^)`\n]*\)?/i,
    type: 'obfuscation_rce',
    severity: 'critical',
    description: '命令替换中下载远程内容',
    scope: 'strict',
    flag: 'cmdsubst_download',
  },
  {
    pattern: /[<>]\(\s*(curl|wget|fetch)\b/i,
    type: 'obfuscation_rce',
    severity: 'critical',
    description: '进程替换中下载执行',
    scope: 'strict',
    flag: 'procsub_download',
  },
];

/**
 * 检测 prompt injection / jailbreak 的正则模式（唯一正则库）
 *
 * 按攻击类别分组，并分 scope：
 * - lenient（默认）：工具结果
 * - strict：记忆写入与 skill 安装（含下方混淆 / RCE 签名）
 */
export const INJECTION_PATTERNS: InjectionPattern[] = [
  // =========================================================================
  // 指令覆盖 (instruction_override)
  // =========================================================================
  {
    pattern: /ignore\s+(?:all\s+)?(?:previous|above|prior|earlier)\s+(?:instructions?|prompts?|rules?|constraints?)/i,
    type: 'instruction_override',
    severity: 'critical',
    description: '试图忽略之前的指令',
  },
  {
    pattern: /disregard\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions?|context)/i,
    type: 'instruction_override',
    severity: 'critical',
    description: '试图无视先前上下文',
  },
  {
    pattern: /forget\s+(?:everything|all|your)\s+(?:instructions?|rules?|training|previous)/i,
    type: 'instruction_override',
    severity: 'critical',
    description: '试图清除指令记忆',
  },
  {
    pattern: /(?:new|updated|revised)\s+(?:system\s+)?instructions?\s*:/i,
    type: 'instruction_override',
    severity: 'high',
    description: '试图注入新系统指令',
  },
  {
    pattern: /\[SYSTEM\]|\[INST\]|<<SYS>>|<\|system\|>|<\|im_start\|>system/i,
    type: 'instruction_override',
    severity: 'critical',
    description: '使用已知的系统标记格式注入指令',
  },
  {
    pattern: /you\s+(?:are|must|should|will)\s+now\s+(?:act|behave|respond|operate)\s+as/i,
    type: 'instruction_override',
    severity: 'high',
    description: '试图重新定义行为模式',
  },
  {
    pattern: /(?:override|replace|update)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?)/i,
    type: 'instruction_override',
    severity: 'high',
    description: '试图替换系统提示',
  },

  // =========================================================================
  // Agent 运行时控制标签伪装 (instruction_override)
  // 子代理消费外部数据/网页后可能把伪造的宿主控制标签抄进自己的最终产出，
  // 借"看起来像系统消息"骗父 Agent 当真指令执行（对齐 Agent SDK 的 control-tag
  // imitation 防护）。只匹配尖括号包裹的标签本体，不匹配散文里提到标签名，
  // 降低对"讨论这个攻击手法"类正常产出的误伤。
  // =========================================================================
  {
    pattern: /<\/?(?:system-reminder|automated_reminder|function_results?|task-notification)>/i,
    type: 'instruction_override',
    severity: 'high',
    description: '伪造 Agent 运行时控制标签（system-reminder/function_results 等）',
  },
  {
    pattern: /<\/?(?:tool_result|tool_use)[ >]/i,
    type: 'instruction_override',
    severity: 'high',
    description: '伪造工具调用/结果标签诱导父 Agent 当真指令执行',
  },

  // =========================================================================
  // 角色劫持 (jailbreak_attempt)
  // =========================================================================
  {
    pattern: /(?:you\s+are|act\s+as|pretend\s+(?:to\s+be|you're)|roleplay\s+as)\s+(?:DAN|evil|unrestricted|unfiltered|jailbroken)/i,
    type: 'jailbreak_attempt',
    severity: 'critical',
    description: '已知的 DAN/越狱角色扮演',
  },
  {
    pattern: /(?:developer|maintenance|debug|admin|root)\s+mode\s+(?:enabled|activated|on)/i,
    type: 'jailbreak_attempt',
    severity: 'high',
    description: '试图激活特权模式',
  },
  {
    pattern: /(?:do\s+anything\s+now|no\s+(?:rules?|restrictions?|limitations?|filters?|guidelines?))/i,
    type: 'jailbreak_attempt',
    severity: 'high',
    description: '试图解除限制',
  },
  {
    pattern: /(?:hypothetical(?:ly)?|theoretically|in\s+fiction)\s+.*(?:ignore|bypass|circumvent)\s+(?:safety|restrictions?|filters?)/i,
    type: 'jailbreak_attempt',
    severity: 'medium',
    description: '通过假设场景绕过安全限制',
  },

  // =========================================================================
  // 数据窃取 (data_exfiltration)
  // =========================================================================
  {
    pattern: /(?:reveal|show|display|print|output|leak|expose)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|configuration|config)/i,
    type: 'data_exfiltration',
    severity: 'high',
    description: '试图提取系统提示',
  },
  {
    pattern: /(?:what\s+(?:are|is)\s+your|tell\s+me\s+your|repeat\s+your)\s+(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?|constraints?)/i,
    type: 'data_exfiltration',
    severity: 'medium',
    description: '试图获取系统指令内容',
  },
  {
    pattern: /(?:send|transmit|post|upload|exfiltrate|forward)\s+(?:to|data\s+to)\s+(?:https?:\/\/|ftp:\/\/)/i,
    type: 'data_exfiltration',
    severity: 'critical',
    description: '试图向外部 URL 发送数据',
  },
  {
    pattern: /(?:curl|wget|fetch|axios|request)\s+.*(?:api[_-]?key|token|secret|password|credential)/i,
    type: 'data_exfiltration',
    severity: 'high',
    description: '试图通过网络请求窃取凭证',
  },

  // =========================================================================
  // Prompt Injection (prompt_injection)
  // =========================================================================
  {
    pattern: /(?:^|\n)\s*(?:IMPORTANT|CRITICAL|URGENT|NOTE)\s*:\s*(?:ignore|disregard|forget|override)/i,
    type: 'prompt_injection',
    severity: 'high',
    description: '使用紧急标记进行指令注入',
  },
  {
    pattern: /(?:assistant|model|AI|bot)\s*:\s*(?:I\s+(?:will|shall|must)|Sure|Of\s+course|Absolutely)/i,
    type: 'prompt_injection',
    severity: 'medium',
    description: '伪造 AI 回复进行注入',
  },
  {
    pattern: /(?:```|<code>)\s*(?:system|admin|root)\s*\n/i,
    type: 'prompt_injection',
    severity: 'medium',
    description: '通过代码块注入系统指令',
  },
  {
    pattern: /(?:end|close|terminate)\s+(?:of\s+)?(?:user\s+)?(?:input|message|query)\s*[.\n]/i,
    type: 'prompt_injection',
    severity: 'medium',
    description: '试图标记用户输入结束以注入指令',
  },
  {
    pattern: /<\/(?:user|human|input)>\s*<(?:system|assistant|admin)>/i,
    type: 'prompt_injection',
    severity: 'high',
    description: '使用 XML 标签切换角色',
  },

  // =========================================================================
  // 敏感数据 (sensitive_data) - 外部数据中意外包含凭证
  // =========================================================================
  {
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
    type: 'sensitive_data',
    severity: 'medium',
    description: '外部数据包含密码',
  },
  {
    pattern: /(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?[a-zA-Z0-9_-]{16,}/i,
    type: 'sensitive_data',
    severity: 'medium',
    description: '外部数据包含 API 密钥',
  },

  // =========================================================================
  // 混淆 / RCE / 外泄签名 (obfuscation_rce) — strict only
  // 从 skillContentGuard 并入，不另起第二套正则库。工具结果不跑这些，
  // 避免教程页里的 `curl | bash` 误伤；记忆写入与 skill 安装 fail-closed。
  // =========================================================================
  ...OBFUSCATION_PATTERNS,
];

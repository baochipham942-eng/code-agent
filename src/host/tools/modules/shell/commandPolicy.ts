// ============================================================================
// Command Policy - bash 命令硬阻断策略
// ============================================================================
//
// BLOCK 档：永远不该执行的命令模式（管道远程执行、反弹 shell、根目录删除等）。
//
// 设计边界：
// - 这是 defense-in-depth 第一层，不是密封防线
// - 正则 pattern 不抗混淆（c\url、变量间接、$(echo cu)$(echo rl) 等可绕过）
// - CONFIRM 档（rm/git push/sudo/chmod 等需要二次确认的）由
//   src/host/agent/confirmationGate.ts 的 HIGH_RISK_PATTERNS 处理，不重复造轮子
// ============================================================================

import { checkWindowsBlockRules } from '../../../security/shellRules/windowsRules';

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  source?: 'hard-block' | 'user-rule';
  action?: 'allow' | 'deny';
  matchedRule?: CommandPolicyRule;
}

interface BlockRule {
  pattern: RegExp;
  reason: string;
}

export type CommandPolicyAction = 'allow' | 'deny';
export type CommandPolicyMatchKind = 'exact' | 'prefix' | 'glob';

export interface CommandPolicyRule {
  action: CommandPolicyAction;
  kind: CommandPolicyMatchKind;
  pattern: string;
  reason?: string;
}

const BLOCK_RULES: BlockRule[] = [
  // 管道执行远程内容
  {
    pattern: /\b(curl|wget|fetch)\b[^|;&]*\|\s*(sh|bash|zsh|ksh|python\d?|node|ruby|perl|php)\b/,
    reason: '管道执行远程脚本（curl|sh 类）',
  },

  // Process substitution 执行远程内容
  {
    pattern: /\b(source|\.|eval|bash|sh|zsh)\s+<\(\s*(curl|wget|fetch)\b/,
    reason: '通过进程替换执行远程脚本（source <(curl ...) 类）',
  },

  // eval $(curl ...)
  {
    pattern: /\beval\s+["']?\$\(\s*(curl|wget|fetch)\b/,
    reason: 'eval 执行远程脚本输出',
  },

  // base64 解码后执行
  {
    pattern: /\bbase64\s+(-d|--decode|-D)\b[^|]*\|\s*(sh|bash|zsh|python\d?|node)\b/,
    reason: 'Base64 解码后管道执行（混淆攻击）',
  },

  // 反弹 shell - bash -i 重定向到 /dev/tcp
  {
    pattern: /\b(bash|sh|zsh)\s+-i\s+>(&|>)\s*\/dev\/(tcp|udp)\//,
    reason: '反弹 shell（bash -i >& /dev/tcp/...）',
  },

  // nc -e / ncat -e 反弹
  {
    pattern: /\b(nc|ncat|netcat)\s+(-[a-zA-Z]*e|--exec)\b/,
    reason: '反弹 shell（nc -e 类）',
  },

  // mkfifo + nc 同行（命名管道反弹 shell）
  {
    pattern: /\bmkfifo\b[\s\S]*\bnc\b\s+\S+\s+\d+/,
    reason: '命名管道反弹 shell（mkfifo + nc）',
  },

  // python/perl reverse shell one-liner
  {
    pattern: /\bpython\d?\s+-c\s+["'][^"']*socket[^"']*connect[^"']*\/bin\/(sh|bash)/,
    reason: 'Python 反弹 shell one-liner',
  },

  // Fork bomb
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: 'Fork bomb',
  },

  // 写 SSH 凭证持久化后门
  {
    pattern: /(>>?|tee\s+(-a\s+)?)\s*~?\/?(\.ssh\/(authorized_keys|id_[a-z]+|config))/,
    reason: '写入 SSH 凭证（持久化后门）',
  },

  // 远程内容写入 shell rc（pipe 或直接重定向 curl/wget 输出）
  // 误杀过滤：合法 echo "export ..." >> ~/.zshrc 不命中（不含 curl/wget）
  {
    pattern: /\b(curl|wget|fetch)\b[\s\S]*?(>>?|\|\s*tee\s+(-a\s+)?)\s*~?\/?(\.zshrc|\.bashrc|\.profile|\.bash_profile|\.zprofile)/,
    reason: '把远程内容写入 shell rc（启动注入）',
  },

  // 删根目录 / 家目录 / 通配根
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+(\/|~\/?|\$HOME\/?|\/\*)\s*(;|&|$)/,
    reason: '删除根目录 / 家目录',
  },

  // sudo / su / pkexec 提权
  {
    pattern: /^(\s*sudo\b|\s*su\s|\s*pkexec\b)/,
    reason: 'Agent 不应提权（sudo / su / pkexec）',
  },

  // 数据外泄：tar/find 后管道送给 curl POST 或 nc
  {
    pattern: /\b(tar|find)\b[^|;]*\|\s*[^|;]*\b(curl\s+[^|;]*-X?\s*POST|curl\s+[^|;]*--data|nc\s+\S+\s+\d+)\b/,
    reason: '数据外泄模式（tar/find | curl POST 或 nc）',
  },

  // dd 写设备
  {
    pattern: /\bdd\b[^;&|]*\bof=\/dev\/(sd[a-z]|nvme|disk|hd[a-z])/,
    reason: '写入物理设备（dd of=/dev/sd*）',
  },
];

let userCommandPolicyRules: CommandPolicyRule[] = [];

function normalizeCommandForRule(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('')
    .map((char) => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      return escapeRegExp(char);
    })
    .join('');
  return new RegExp(`^${source}$`);
}

function matchesCommandRule(command: string, rule: CommandPolicyRule): boolean {
  const normalizedCommand = normalizeCommandForRule(command);
  const normalizedPattern = normalizeCommandForRule(rule.pattern);
  if (!normalizedPattern) return false;

  switch (rule.kind) {
    case 'exact':
      return normalizedCommand === normalizedPattern;
    case 'prefix':
      return normalizedCommand === normalizedPattern || normalizedCommand.startsWith(`${normalizedPattern} `);
    case 'glob':
      return globToRegExp(normalizedPattern).test(normalizedCommand);
  }
}

export function parseCommandPolicyRule(raw: string): CommandPolicyRule | null {
  const match = raw.match(/^(allow|deny):(exact|prefix|glob):([\s\S]+)$/);
  if (!match) return null;
  const pattern = match[3].trim();
  if (!pattern) return null;
  return {
    action: match[1] as CommandPolicyAction,
    kind: match[2] as CommandPolicyMatchKind,
    pattern,
  };
}

export function setCommandPolicyRules(rules: Array<CommandPolicyRule | string>): void {
  userCommandPolicyRules = rules.flatMap((rule) => {
    if (typeof rule === 'string') {
      const parsed = parseCommandPolicyRule(rule);
      return parsed ? [parsed] : [];
    }
    return [rule];
  });
}

export function setCommandPolicyRulesForTest(rules: Array<CommandPolicyRule | string>): void {
  setCommandPolicyRules(rules);
}

export function evaluateCommandPolicyRules(
  command: string,
  rules: CommandPolicyRule[] = userCommandPolicyRules,
): PolicyDecision {
  const matchingDeny = rules.find((rule) => rule.action === 'deny' && matchesCommandRule(command, rule));
  if (matchingDeny) {
    return {
      allowed: false,
      action: 'deny',
      source: 'user-rule',
      reason: matchingDeny.reason ?? `User command policy denied ${matchingDeny.kind}:${matchingDeny.pattern}`,
      matchedRule: matchingDeny,
    };
  }

  const matchingAllow = rules.find((rule) => rule.action === 'allow' && matchesCommandRule(command, rule));
  if (matchingAllow) {
    return {
      allowed: true,
      action: 'allow',
      source: 'user-rule',
      reason: matchingAllow.reason ?? `User command policy allowed ${matchingAllow.kind}:${matchingAllow.pattern}`,
      matchedRule: matchingAllow,
    };
  }

  return { allowed: true };
}

/**
 * 检查命令是否命中 BLOCK 规则
 *
 * @param command 已 normalize 过的 bash 命令
 * @returns allowed=false 时 reason 必填
 */
export function checkCommandPolicy(command: string): PolicyDecision {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: true };

  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        allowed: false,
        action: 'deny',
        source: 'hard-block',
        reason: rule.reason,
      };
    }
  }

  // win32 下 bash 工具走 PowerShell（platformShell.ts）：叠加 Windows 硬毙清单。
  // POSIX 规则在上面照常跑（覆盖 Git-Bash / 显式 bash 场景），两包叠加。
  if (process.platform === 'win32') {
    const winBlock = checkWindowsBlockRules(trimmed);
    if (winBlock.blocked) {
      return {
        allowed: false,
        action: 'deny',
        source: 'hard-block',
        reason: winBlock.reason,
      };
    }
  }

  return evaluateCommandPolicyRules(trimmed);
}

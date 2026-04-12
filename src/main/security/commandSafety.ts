// ============================================================================
// Command Safety - 安全命令白名单 + 危险命令检测 + 复合命令解析
// ============================================================================
//
// 统一的命令安全评估模块：
// - 安全命令白名单（isKnownSafeCommand）：安全命令自动跳过审批
// - 危险命令检测（validateCommand）：critical 级别直接拦截
// - 复合命令解析：支持 &&, ||, ;, | 操作符
//
// 原 CommandMonitor 的危险模式已合并到此文件。

import { createLogger } from '../services/infra/logger';

const logger = createLogger('CommandSafety');

// ----------------------------------------------------------------------------
// 无条件安全的命令 — 只读操作，不修改任何状态
// ----------------------------------------------------------------------------

const UNCONDITIONALLY_SAFE = new Set([
  // 文件内容查看
  'cat', 'head', 'tail', 'less', 'more',
  // 文本处理（纯管道，不写文件）
  'wc', 'sort', 'uniq', 'cut', 'paste', 'tr', 'rev', 'nl',
  'comm', 'fold', 'fmt', 'column', 'expand', 'unexpand',
  // 输出
  'echo', 'printf', 'expr', 'true', 'false', 'test',
  // 系统信息
  'ls', 'pwd', 'which', 'where', 'whoami', 'id', 'uname',
  'hostname', 'date', 'cal', 'uptime',
  // 环境
  'env', 'printenv',
  // 搜索（只读）
  'grep', 'egrep', 'fgrep', 'rg', 'ag',
  // 文件信息（不修改）
  'file', 'stat', 'du', 'df', 'md5', 'md5sum', 'sha256sum', 'shasum',
  // 路径操作
  'basename', 'dirname', 'realpath', 'readlink',
  // 数据处理
  'jq', 'yq', 'xargs',
  // 差异对比
  'diff', 'colordiff',
  // 序列
  'seq', 'yes',
  // 数学
  'bc',
]);

// ----------------------------------------------------------------------------
// 条件安全的命令 — 特定参数组合下安全
// ----------------------------------------------------------------------------

type SafetyChecker = (args: string[]) => boolean;

const CONDITIONALLY_SAFE: Record<string, SafetyChecker> = {
  // find: 安全，除非有副作用操作
  find: (args) => !args.some(a =>
    ['-exec', '-execdir', '-delete', '-fls', '-fprint', '-fprintf'].includes(a)
  ),

  // git: 仅只读子命令
  git: (args) => {
    const safeSubcommands = new Set([
      'status', 'log', 'diff', 'show', 'branch', 'tag',
      'remote', 'describe', 'rev-parse', 'rev-list',
      'shortlog', 'blame', 'ls-files', 'ls-tree',
      'cat-file', 'config', 'reflog',
    ]);
    const subcommand = args[0];
    if (!subcommand) return false;

    // stash list 是安全的，stash pop/drop 不是
    if (subcommand === 'stash' && args[1] === 'list') return true;

    // -c 全局配置覆盖可执行任意外部命令
    if (args.includes('-c')) return false;

    return safeSubcommands.has(subcommand);
  },

  // npm/yarn/pnpm: 仅只读子命令
  npm: (args) => {
    const safeSubcommands = new Set([
      'list', 'ls', 'view', 'info', 'outdated', 'audit',
      'why', 'explain', 'config', 'help', 'search', 'pack',
      'version', // 不带参数只是查看版本
    ]);
    return safeSubcommands.has(args[0]);
  },

  yarn: (args) => {
    const safeSubcommands = new Set([
      'list', 'info', 'why', 'outdated', 'audit', 'config',
    ]);
    return safeSubcommands.has(args[0]);
  },

  pnpm: (args) => {
    const safeSubcommands = new Set([
      'list', 'ls', 'why', 'outdated', 'audit', 'config',
    ]);
    return safeSubcommands.has(args[0]);
  },

  // python3/python: -c 单行或 --version 安全
  python3: (args) => args[0] === '--version' || args[0] === '-V',
  python: (args) => args[0] === '--version' || args[0] === '-V',
  node: (args) => args[0] === '--version' || args[0] === '-v',

  // sed: 只有 -n 打印模式安全（不修改文件）
  sed: (args) => args.includes('-n') && !args.includes('-i'),

  // awk: 不含 system() 和输出重定向
  awk: (args) => !args.some(a =>
    typeof a === 'string' && (a.includes('system(') || />\s/.test(a))
  ),

  // docker: 仅信息查询
  docker: (args) => {
    const safeSubcommands = new Set([
      'ps', 'images', 'info', 'version', 'inspect',
      'logs', 'stats', 'top', 'port', 'network',
    ]);
    return safeSubcommands.has(args[0]);
  },

  // base64: 不带 -o/--output 是安全的（只输出到 stdout）
  base64: (args) => !args.some(a => a === '-o' || a.startsWith('--output')),

  // curl: 不带 -o/-O/-d/--data/--upload 是安全的（只 GET 到 stdout）
  curl: (args) => !args.some(a =>
    ['-o', '-O', '-d', '--data', '--upload-file', '-T', '-X', '--request'].includes(a)
      // POST/PUT/DELETE 等不是只读
      || (a === '-X' || a === '--request')
  ),

  // wget: 只有 -q -O - 管道模式安全
  wget: (args) => args.includes('-O') && args.includes('-') && !args.some(a => a === '-P'),

  // tsc: --noEmit 是安全的（不生成文件）
  tsc: (args) => args.includes('--noEmit'),
};

// ----------------------------------------------------------------------------
// 复合命令解析
// ----------------------------------------------------------------------------

/**
 * 将复合 bash 命令拆分为子命令
 * 支持 &&, ||, ;, | 操作符
 * 不支持子 shell ()、命令替换 $()、后台 &
 */
function splitCompoundCommand(command: string): string[] | null {
  // 检测不安全的 shell 特性
  const unsafePatterns = [
    /\$\(/,     // 命令替换 $(...)
    /`[^`]+`/,  // 反引号命令替换
    /\(\s*\w/,  // 子 shell
    /;\s*$/,    // 尾部分号（可能有后续命令未显示）
  ];

  for (const pattern of unsafePatterns) {
    if (pattern.test(command)) return null;
  }

  // 按 &&, ||, ;, | 分割（简化版，不处理引号内的分隔符）
  // 使用状态机追踪引号
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      i++;
    } else if (!inSingleQuote && !inDoubleQuote) {
      // 检查分隔符
      if (command[i] === '&' && command[i + 1] === '&') {
        parts.push(current.trim());
        current = '';
        i += 2;
      } else if (command[i] === '|' && command[i + 1] === '|') {
        parts.push(current.trim());
        current = '';
        i += 2;
      } else if (command[i] === ';') {
        parts.push(current.trim());
        current = '';
        i++;
      } else if (command[i] === '|' && command[i + 1] !== '|') {
        // 管道 — 左侧可以是任何命令，右侧也需要检查
        parts.push(current.trim());
        current = '';
        i++;
      } else {
        current += ch;
        i++;
      }
    } else {
      current += ch;
      i++;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts.filter(p => p.length > 0);
}

/**
 * 解析单个命令为 (程序名, 参数列表)
 * 处理 bash -c "..." 和 bash -lc "..." 包裹
 */
function parseCommand(command: string): { program: string; args: string[] } | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  // 简单分词（尊重引号）
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if ((ch === ' ' || ch === '\t') && !inSingleQuote && !inDoubleQuote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) return null;

  const program = tokens[0];
  const args = tokens.slice(1);

  // 解包 bash -c "..." 和 bash -lc "..."
  if ((program === 'bash' || program === 'sh' || program === 'zsh') &&
      args.length >= 2 &&
      (args[0] === '-c' || args[0] === '-lc')) {
    // 递归解析内部命令
    return parseCommand(args[1]);
  }

  return { program, args };
}

/**
 * 检查输出重定向
 */
function hasOutputRedirection(command: string): boolean {
  // 检查 > 和 >> 重定向（但排除 2>&1 这种 stderr 重定向）
  // 简化：检查非引号内的 > 字符（前面不是数字或&）
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (ch === '>' && !inSingleQuote && !inDoubleQuote) {
      // 排除 2>&1, >&2 等 fd 重定向
      const prev = i > 0 ? command[i - 1] : '';
      const next = i < command.length - 1 ? command[i + 1] : '';
      if (prev === '&' || next === '&') continue;
      // 排除 >> /dev/null（无副作用）
      const rest = command.substring(i).replace(/^>+\s*/, '');
      if (rest.startsWith('/dev/null')) continue;
      return true;
    }
  }

  return false;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * 判断命令是否为已知安全命令
 *
 * 安全命令：不修改文件系统、不发起网络请求、不修改系统状态
 *
 * @param command - 完整的 bash 命令字符串
 * @returns true 如果命令已知安全，可跳过用户审批
 */
export function isKnownSafeCommand(command: string): boolean {
  // 0. 空命令不安全
  if (!command?.trim()) {
    return false;
  }

  // 1. 检查输出重定向 — 有重定向就不安全
  if (hasOutputRedirection(command)) {
    return false;
  }

  // 2. 拆分复合命令
  const subCommands = splitCompoundCommand(command);
  if (!subCommands || subCommands.length === 0) {
    // 含有不安全 shell 特性（命令替换、子shell）或空命令
    return false;
  }

  // 3. 每个子命令都必须安全
  for (const sub of subCommands) {
    const parsed = parseCommand(sub);
    if (!parsed) return false;

    const { program, args } = parsed;

    // 无条件安全
    if (UNCONDITIONALLY_SAFE.has(program)) continue;

    // 条件安全
    const checker = CONDITIONALLY_SAFE[program];
    if (checker && checker(args)) continue;

    // 未知命令 — 不安全
    return false;
  }

  return true;
}

/**
 * 获取命令的安全分类
 *
 * @returns 'safe' | 'conditional' | 'unknown' | 'dangerous'
 */
export function classifyCommand(command: string): 'safe' | 'conditional' | 'unknown' {
  if (isKnownSafeCommand(command)) return 'safe';

  // 检查是否可能是条件安全但参数不对
  const parsed = parseCommand(command.trim());
  if (parsed && CONDITIONALLY_SAFE[parsed.program]) return 'conditional';

  return 'unknown';
}

// ----------------------------------------------------------------------------
// 危险命令检测（原 CommandMonitor 逻辑）
// ----------------------------------------------------------------------------

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  riskLevel: RiskLevel;
  securityFlags: string[];
  suggestion?: string;
}

interface DangerousPattern {
  pattern: RegExp;
  riskLevel: RiskLevel;
  flag: string;
  reason: string;
  suggestion?: string;
}

// 绝对拦截的命令（永远不允许执行）
const BLOCKED_PATTERNS: DangerousPattern[] = [
  { pattern: /rm\s+-rf\s+\/\s*$/, riskLevel: 'critical', flag: 'root_delete', reason: 'Attempting to delete root filesystem' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, riskLevel: 'critical', flag: 'fork_bomb', reason: 'Fork bomb detected' },
  { pattern: />\s*\/dev\/sda\s*$/, riskLevel: 'critical', flag: 'disk_wipe', reason: 'Attempting to wipe primary disk' },
];

// 危险命令模式（按风险等级标记，critical 级别拦截）
const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // 文件系统破坏
  { pattern: /rm\s+(-[rRf]+\s+)*[\/~]/, riskLevel: 'critical', flag: 'recursive_delete', reason: 'Recursive deletion from root or home directory', suggestion: 'Specify a more precise path or use trash instead of rm' },
  { pattern: /rm\s+-rf?\s+\*/, riskLevel: 'critical', flag: 'wildcard_delete', reason: 'Recursive deletion with wildcard' },
  { pattern: /rm\s+-rf?\s+\.\s*$/, riskLevel: 'critical', flag: 'current_dir_delete', reason: 'Deleting current directory' },
  // 磁盘操作
  { pattern: />\s*\/dev\/sd[a-z]/, riskLevel: 'critical', flag: 'disk_overwrite', reason: 'Writing directly to disk device' },
  { pattern: /mkfs\./, riskLevel: 'critical', flag: 'format_disk', reason: 'Formatting disk' },
  { pattern: /dd\s+if=.*of=\/dev\//, riskLevel: 'critical', flag: 'dd_to_device', reason: 'Direct disk write with dd' },
  // Fork bomb
  { pattern: /:\(\)\s*\{.*\}/, riskLevel: 'critical', flag: 'fork_bomb', reason: 'Potential fork bomb detected' },
  // Git 危险操作
  { pattern: /git\s+push\s+.*--force/, riskLevel: 'high', flag: 'git_force_push', reason: 'Force push may overwrite remote history', suggestion: 'Use --force-with-lease for safer force push' },
  { pattern: /git\s+reset\s+--hard/, riskLevel: 'high', flag: 'git_hard_reset', reason: 'Hard reset discards uncommitted changes', suggestion: 'Consider git stash before reset' },
  { pattern: /git\s+clean\s+-[dxf]+/, riskLevel: 'medium', flag: 'git_clean', reason: 'Git clean removes untracked files', suggestion: 'Use git clean -n first to preview' },
  // 权限变更
  { pattern: /chmod\s+(-R\s+)?777/, riskLevel: 'high', flag: 'chmod_777', reason: 'Setting world-writable permissions', suggestion: 'Use more restrictive permissions like 755 or 644' },
  { pattern: /chmod\s+-R\s+/, riskLevel: 'medium', flag: 'recursive_chmod', reason: 'Recursive permission change' },
  { pattern: /chown\s+-R\s+/, riskLevel: 'medium', flag: 'recursive_chown', reason: 'Recursive ownership change' },
  // 提权
  { pattern: /sudo\s+rm\s+-rf?/, riskLevel: 'critical', flag: 'sudo_rm', reason: 'Privileged recursive deletion' },
  { pattern: /sudo\s+chmod/, riskLevel: 'high', flag: 'sudo_chmod', reason: 'Privileged permission change' },
  // 管道到 shell
  { pattern: /curl.*\|\s*(ba)?sh/, riskLevel: 'high', flag: 'pipe_to_shell', reason: 'Piping remote content to shell', suggestion: 'Download and review script before executing' },
  { pattern: /wget.*\|\s*(ba)?sh/, riskLevel: 'high', flag: 'pipe_to_shell', reason: 'Piping remote content to shell' },
  // 进程操作
  { pattern: /kill\s+-9\s+-1/, riskLevel: 'critical', flag: 'kill_all', reason: 'Killing all processes' },
  { pattern: /killall\s+-9/, riskLevel: 'high', flag: 'killall', reason: 'Force killing processes by name' },
  // 系统控制
  { pattern: /shutdown|reboot|halt|poweroff/, riskLevel: 'high', flag: 'system_shutdown', reason: 'System shutdown or reboot command' },
  // 历史清除
  { pattern: /history\s+-c/, riskLevel: 'medium', flag: 'history_clear', reason: 'Clearing command history' },
  // 环境变量篡改
  { pattern: /export\s+PATH=["']?[^:$]/, riskLevel: 'medium', flag: 'path_override', reason: 'Overriding PATH environment variable' },
  // 敏感文件
  { pattern: /cat\s+.*\/etc\/shadow/, riskLevel: 'high', flag: 'shadow_access', reason: 'Accessing password shadow file' },
  // SSH 密钥
  { pattern: /ssh-keygen.*-y.*>/, riskLevel: 'medium', flag: 'ssh_key_export', reason: 'Exporting SSH public key from private key' },
];

// 敏感环境变量访问检测
const SENSITIVE_ENV_PATTERNS = [
  /\$\{?[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z_]*\}?/i,
  /env\s+[A-Z_]*(?:KEY|SECRET|TOKEN)/i,
  /printenv\s+[A-Z_]*(?:KEY|SECRET)/i,
];

/**
 * 验证命令安全性（危险命令检测）
 *
 * @returns ValidationResult — critical 级别命令会被拦截（allowed=false）
 */
export function validateCommand(command: string): ValidationResult {
  if (!command?.trim()) {
    return { allowed: true, riskLevel: 'safe', securityFlags: [] };
  }

  // 绝对拦截
  for (const p of BLOCKED_PATTERNS) {
    if (p.pattern.test(command)) {
      logger.warn('Blocked command detected', { command: command.substring(0, 100), flag: p.flag });
      return { allowed: false, reason: p.reason, riskLevel: 'critical', securityFlags: [p.flag] };
    }
  }

  // 危险模式匹配
  const securityFlags: string[] = [];
  let highestRisk: RiskLevel = 'safe';
  let blockReason: string | undefined;
  let suggestion: string | undefined;
  const riskOrder: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];

  for (const p of DANGEROUS_PATTERNS) {
    if (p.pattern.test(command)) {
      securityFlags.push(p.flag);
      if (riskOrder.indexOf(p.riskLevel) > riskOrder.indexOf(highestRisk)) {
        highestRisk = p.riskLevel;
        blockReason = p.reason;
        suggestion = p.suggestion;
      }
    }
  }

  // 敏感环境变量访问
  if (SENSITIVE_ENV_PATTERNS.some(p => p.test(command))) {
    securityFlags.push('env_access');
    if (highestRisk === 'safe') highestRisk = 'low';
  }

  return {
    allowed: highestRisk !== 'critical',
    riskLevel: highestRisk,
    securityFlags,
    reason: blockReason,
    suggestion,
  };
}

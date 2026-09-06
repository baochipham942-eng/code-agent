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
import { quote } from 'shell-quote';
import {
  checkWindowsBlockRules,
  evaluateWindowsDanger,
  isKnownSafeWindowsCommand,
} from './shellRules/windowsRules';
import { RM_FLAGS, RM_FLAGS_REQUIRED, RM_HEAD } from './rmFlagPattern';
import { canonicalizeCommand } from './canonicalizeCommand';
import {
  commandWordsFromParse,
  parseShellCommand,
  qualificationExecutions,
  qualificationExecutable,
} from './commandParse';
import {
  rmIsContainedInWorkspace,
  type RecursiveRmPathContext,
} from './recursiveRmPathSafety';

const logger = createLogger('CommandSafety');

// ----------------------------------------------------------------------------
// Shell 维度（windows-support.md §3.2：共享分级框架 + 平台规则包）
// ----------------------------------------------------------------------------

export type ShellKind = 'posix' | 'powershell';

/** win32 上 bash 工具走 PowerShell（platformShell.ts），其余平台 POSIX shell */
export function defaultShellKind(): ShellKind {
  return process.platform === 'win32' ? 'powershell' : 'posix';
}

export type ShellSafetyMode = 'strict' | 'lenient';

/**
 * 安全模式（2026-06-10 决策 lenient 作 win32 默认；2026-07-16 v0.27.3 起收口）：
 * - strict：未识别命令落分类器，判不准才走用户确认（fail-closed）——全平台默认
 * - lenient：硬毙清单照拦，非硬毙一律放行、不进审批。**只剩 env 显式开启**：
 *   `CODE_AGENT_SHELL_SAFETY_MODE=lenient`（朋友测试包专用）
 *
 * win32 曾默认 lenient，前提是「白名单从零起步，strict 会每两条命令弹一次确认」。
 * 该前提已不成立：WINDOWS_SAFE_CMDLETS + POSIX 安全集兜底 + 别名展开已铺开，
 * 且 strict 下未识别命令先过分类器（toolExecutor.ts 的 P1），与 mac/linux 同路径。
 * v0.27.3 起 Windows 正式对外分发，平台默认必须与 mac 对齐，否则等于对全量
 * Windows 用户关掉命令安全闸。
 */
export function getShellSafetyMode(): ShellSafetyMode {
  const env = process.env.CODE_AGENT_SHELL_SAFETY_MODE;
  if (env === 'strict' || env === 'lenient') return env;
  return 'strict';
}

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
  'ls', 'pwd', 'which', 'where', 'type', 'whoami', 'id', 'uname',
  'hostname', 'date', 'cal', 'uptime',
  // 环境（env 能执行后续命令，不能列入无条件安全集）
  'printenv',
  // 搜索（只读）
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'fd',
  // 文件信息（不修改）
  'file', 'stat', 'du', 'df', 'md5', 'md5sum', 'sha256sum', 'shasum',
  // 路径操作
  'basename', 'dirname', 'realpath', 'readlink',
  // 数据处理
  // xargs 是 stdin→argv 的命令执行器，不能按数据处理器免审批
  'jq', 'yq',
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

// Delegated execution is not an intrinsic effect of the prefix: later argv/stdin
// supplies the operation. Keep that distinction for approval-prefix learning.
type SafetyChecker = (args: string[]) => boolean | 'delegated';

const CONDITIONALLY_SAFE: Record<string, SafetyChecker> = {
  // env 只有在最终仍是“打印环境”时才安全。首个非选项、非赋值词会被 env
  // 当作待执行程序；一旦出现就交回审批层判断，不能让包裹命令继承 env 白名单。
  env: (args) => {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
      if (['-i', '--ignore-environment', '-0', '--null', '-v', '--debug'].includes(arg)) continue;
      if (arg === '-u' || arg === '--unset') {
        if (!args[index + 1]) return 'delegated';
        index += 1;
        continue;
      }
      if (arg.startsWith('--unset=') && arg.length > '--unset='.length) continue;
      if (arg === '--') continue;
      return 'delegated';
    }
    return true;
  },

  // The command and additional operands come from argv/stdin, even with no flags.
  xargs: () => 'delegated',

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
    return args[0] === '-v'
      || safeSubcommands.has(args[0]);
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
  cargo: (args) => args[0] === '--version',
  rustc: (args) => args[0] === '--version',

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

  // wget: 版本查询，或 -q -O - 管道模式安全
  wget: (args) => args[0] === '--version'
    || (args.includes('-O') && args.includes('-') && !args.some(a => a === '-P')),

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
export function splitCompoundCommand(command: string): string[] | null {
  const parsed = parseShellCommand(command);
  if (parsed.parsingFailed || parsed.trailingOperator) return null;
  // Rebuilding from decoded words erases how the command was spelled: `$'l'"\x73"` comes back as a
  // clean `ls`, and every identity check downstream then judges a command the user never wrote.
  // Refuse to rebuild instead — both callers treat a null split as "needs approval".
  if (parsed.segments.some((segment) => segment.mixedIdentity.some(Boolean))) return null;
  return parsed.segments.map((segment) => quote(segment.words));
}

/**
 * 解析单个命令为 (程序名, 参数列表)
 * 处理 bash -c "..." 和 bash -lc "..." 包裹
 */
export function commandWords(command: string): string[] | null {
  return commandWordsFromParse(command);
}

/**
 * 检查输出重定向
 */
function hasOutputRedirection(command: string): boolean {
  const parsed = parseShellCommand(command);
  return parsed.parsingFailed
    || parsed.writeTargets.some((target) => target.source === 'redirect' && target.path !== '/dev/null');
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * 判断命令是否为已知安全命令
 *
 * 安全命令：不修改文件系统、不发起网络请求、不修改系统状态
 *
 * @param command - 完整的 shell 命令字符串
 * @param shell - 命令将运行的 shell（默认按平台推断）
 * @returns true 如果命令已知安全，可跳过用户审批
 */
export function isKnownSafeCommand(command: string, shell: ShellKind = defaultShellKind()): boolean {
  const canonical = canonicalizeCommand(command);

  // 0. 空命令和无法可靠拆词的命令都不走免审批捷径
  if (!canonical.command || canonical.parsingFailed) {
    return false;
  }

  // 1. 检查输出重定向 — 有重定向就不安全（'>' 语义 POSIX/PowerShell 一致）
  if (hasOutputRedirection(command)) {
    return false;
  }

  // PowerShell：白名单按规范 cmdlet 名判定（别名在 windowsRules 规范化层消化）；
  // 子表达式 $() 可隐藏任意调用，安全分类一律视为不安全
  if (shell === 'powershell') {
    if (command.includes('$(') || command.includes('`')) return false;
    return isKnownSafeWindowsCommand(command, UNCONDITIONALLY_SAFE);
  }

  // 2. Qualification uses the command identity as written.  The shared parser's
  // broader execution view is intentionally reserved for write-target extraction.
  const executions = qualificationExecutions(command);
  if (!executions || executions.length === 0) {
    return false;
  }

  // 3. Every written/explicitly baseline-unwrapped command must be safe.
  for (const execution of executions) {
    const { program, args } = execution;

    // 无条件安全
    if (UNCONDITIONALLY_SAFE.has(program)) continue;

    // 条件安全
    const checker = CONDITIONALLY_SAFE[program];
    if (checker?.(args) === true) continue;

    // 未知命令 — 不安全
    return false;
  }

  return true;
}

/**
 * 获取命令的安全分类
 *
 * Delegated means the operation is supplied by later arguments or stdin, so a
 * prefix approval cannot authorize it. Unknown is not a positive risk finding.
 */
export function classifyCommand(command: string, shell: ShellKind = defaultShellKind()): 'safe' | 'conditional' | 'unknown' | 'delegated' {
  if (isKnownSafeCommand(command, shell)) return 'safe';

  // 检查是否可能是条件安全但参数不对。
  // `env` / `xargs` 把真正的操作交给后续 argv 或 stdin：委托要按写下来的前缀判定，解包到被委托的
  // 程序，答的就不是「这条前缀规则能不能承载风险」这个问题（execPolicy.prefixCarriesTheRisk）。
  const words = commandWordsFromParse(command.trim());
  if (words && CONDITIONALLY_SAFE[words[0]]?.(words.slice(1)) === 'delegated') return 'delegated';

  const execution = qualificationExecutable(command.trim());
  if (execution && CONDITIONALLY_SAFE[execution.program]?.(execution.args) === 'delegated') return 'delegated';
  if (execution && CONDITIONALLY_SAFE[execution.program]) return 'conditional';

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
  canonicalCommand: string;
  parsingFailed: boolean;
  parsingFailureReason?: string;
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
  // 文件系统破坏 —— 分两级：
  //  · 删"具体路径"(如 /Applications/Foo.app、~/Library/xxx) → high，走一次确认，不硬毙
  //  · 删根 / 家 / 系统目录 / 整个顶级容器目录 → critical，硬毙
  // 宽匹配先标 high，保证任何删 / 或 ~ 路径的 rm 至少要确认，绝不会因细分漏判而降成 safe；
  // validateCommand 取最高风险，灾难性子集会被下面 critical 模式拽回硬毙。
  // flag 前缀用共享 RM_FLAGS（短簇/长选项/=值/任意序），命令头用 RM_HEAD（词边界），
  // 杜绝 `rm --recursive /` / `rm --interactive=never /` 旁路与 `confirm /` 误判
  { pattern: /(?<![\w-])rm\s+(?=[^;&|\n]*(?:-[A-Za-z]*[rR]|--recursive))(?=[^;&|\n]*(?:-[A-Za-z]*f|--force))(?:-[^\s]+|--[^\s]+)(?:\s+(?:-[^\s]+|--[^\s]+))*\s+[^\s;&|]+/, riskLevel: 'high', flag: 'recursive_delete_targeted', reason: 'Recursive/forced deletion of a specific path', suggestion: 'Confirm the exact target; consider trash instead of rm' },
  { pattern: new RegExp(`${RM_HEAD}${RM_FLAGS}[/~]`), riskLevel: 'high', flag: 'recursive_delete_targeted', reason: 'Recursive/forced deletion of a specific path', suggestion: 'Confirm the exact target; consider trash instead of rm' },
  { pattern: new RegExp(`${RM_HEAD}${RM_FLAGS}/(\\s|$|\\*)`), riskLevel: 'critical', flag: 'root_delete', reason: 'Recursive deletion of the root directory' },
  { pattern: new RegExp(`${RM_HEAD}${RM_FLAGS}(~|\\$HOME)/?(\\s|$|\\*)`), riskLevel: 'critical', flag: 'home_delete', reason: 'Recursive deletion of the entire home directory' },
  { pattern: new RegExp(`${RM_HEAD}${RM_FLAGS}/(System|usr|bin|sbin|etc|var|private|opt|cores|dev|Network|Library)(/|\\s|$)`), riskLevel: 'critical', flag: 'system_dir_delete', reason: 'Recursive deletion of a system directory' },
  { pattern: new RegExp(`${RM_HEAD}${RM_FLAGS}/(Applications|Users|Volumes)/?(\\s|$|\\*)`), riskLevel: 'critical', flag: 'container_dir_delete', reason: 'Recursive deletion of an entire top-level directory' },
  { pattern: new RegExp(`${RM_HEAD}${RM_FLAGS_REQUIRED}\\*`), riskLevel: 'critical', flag: 'wildcard_delete', reason: 'Recursive deletion with wildcard' },
  { pattern: new RegExp(`${RM_HEAD}${RM_FLAGS_REQUIRED}\\.\\s*$`), riskLevel: 'critical', flag: 'current_dir_delete', reason: 'Deleting current directory' },
  // 磁盘操作
  { pattern: />\s*\/dev\/sd[a-z]/, riskLevel: 'critical', flag: 'disk_overwrite', reason: 'Writing directly to disk device' },
  { pattern: /mkfs\./, riskLevel: 'critical', flag: 'format_disk', reason: 'Formatting disk' },
  { pattern: /\bdd\b[^;&|\n]*\bof=\/dev\//, riskLevel: 'critical', flag: 'dd_to_device', reason: 'Direct disk write with dd' },
  // Fork bomb
  { pattern: /:\(\)\s*\{.*\}/, riskLevel: 'critical', flag: 'fork_bomb', reason: 'Potential fork bomb detected' },
  // Git 危险操作
  { pattern: /git\s+push\b[^;&|\n]*\s(?:--force\S*|-[A-Za-z]*f[A-Za-z]*)(?=\s|$)/, riskLevel: 'high', flag: 'git_force_push', reason: 'Force push may overwrite remote history', suggestion: 'Use --force-with-lease for safer force push' },
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
  /\$\{?[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z0-9_]*\}?/i,
  /env\s+[A-Z0-9_]*(?:KEY|SECRET|TOKEN)/i,
  /printenv\s+[A-Z0-9_]*(?:KEY|SECRET)/i,
];

/**
 * 验证命令安全性（危险命令检测）
 *
 * posix 模式始终运行（Windows 上覆盖 Git-Bash / 显式 bash 场景）；
 * shell=powershell 时叠加 Windows 规则包（硬毙 + 分级）。
 *
 * @returns ValidationResult — critical 级别命令会被拦截（allowed=false）
 */
export function validateCommand(
  command: string,
  shell: ShellKind = defaultShellKind(),
  pathContext?: RecursiveRmPathContext,
): ValidationResult {
  const canonical = canonicalizeCommand(command ?? '');
  const normalized = canonical.command;
  const analysis = {
    canonicalCommand: normalized,
    parsingFailed: canonical.parsingFailed,
    ...(canonical.failureReason ? { parsingFailureReason: canonical.failureReason } : {}),
  };
  if (!normalized) {
    return { ...analysis, allowed: true, riskLevel: 'safe', securityFlags: [] };
  }

  // Windows 硬毙清单（任何安全模式下都拦）
  if (shell === 'powershell') {
    const winBlock = checkWindowsBlockRules(normalized);
    if (winBlock.blocked) {
      logger.warn('Blocked command detected (windows rules)', {
        command: command.substring(0, 100), flag: winBlock.flag,
      });
      return {
        ...analysis,
        allowed: false,
        reason: winBlock.reason,
        riskLevel: 'critical',
        securityFlags: winBlock.flag ? [winBlock.flag] : [],
      };
    }
  }

  // 绝对拦截
  for (const p of BLOCKED_PATTERNS) {
    if (p.pattern.test(normalized)) {
      logger.warn('Blocked command detected', { command: normalized.substring(0, 100), flag: p.flag });
      return { ...analysis, allowed: false, reason: p.reason, riskLevel: 'critical', securityFlags: [p.flag] };
    }
  }

  // 危险模式匹配
  const securityFlags: string[] = [];
  let highestRisk: RiskLevel = 'safe';
  let blockReason: string | undefined;
  let suggestion: string | undefined;
  const riskOrder: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];

  for (const p of DANGEROUS_PATTERNS) {
    if (!p.pattern.test(normalized)) continue;
    const workspaceContainedSystemDelete = pathContext
      && (p.flag === 'system_dir_delete' || p.flag === 'container_dir_delete')
      && rmIsContainedInWorkspace(normalized, pathContext);
    if (workspaceContainedSystemDelete) continue;
    securityFlags.push(p.flag);
    if (riskOrder.indexOf(p.riskLevel) > riskOrder.indexOf(highestRisk)) {
      highestRisk = p.riskLevel;
      blockReason = p.reason;
      suggestion = p.suggestion;
    }
  }

  // Windows 分级危险清单（与 posix 模式取最高风险合并）
  if (shell === 'powershell') {
    for (const finding of evaluateWindowsDanger(normalized)) {
      securityFlags.push(finding.flag);
      if (riskOrder.indexOf(finding.riskLevel) > riskOrder.indexOf(highestRisk)) {
        highestRisk = finding.riskLevel;
        blockReason = finding.reason;
        suggestion = finding.suggestion;
      }
    }
  }

  // 敏感环境变量访问
  if (SENSITIVE_ENV_PATTERNS.some(p => p.test(normalized))) {
    securityFlags.push('env_access');
    if (highestRisk === 'safe') highestRisk = 'low';
  }

  return {
    ...analysis,
    allowed: highestRisk !== 'critical',
    riskLevel: highestRisk,
    securityFlags,
    reason: blockReason,
    suggestion,
  };
}

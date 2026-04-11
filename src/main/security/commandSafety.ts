// ============================================================================
// Command Safety - 安全命令白名单 + 复合命令解析
// ============================================================================
//
// 借鉴 Codex CLI 的 is_known_safe_command 设计：
// - 无条件安全命令：永远不修改文件系统或网络
// - 条件安全命令：特定参数组合下安全
// - 复合命令解析：支持 &&, ||, ;, | 操作符
//
// 用于 ToolExecutor 中，安全命令自动跳过审批。

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

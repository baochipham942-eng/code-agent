// ============================================================================
// Windows Shell Rules - PowerShell / cmd 命令安全规则包
// ============================================================================
//
// 设计（docs/architecture/windows-support.md §3.2）：规范化先行——
// PowerShell 是别名体系（rm/del/erase/rd/ri 都是 Remove-Item），参数可前缀缩写
// 且大小写不敏感（-Recurse ≡ -r ≡ -re...），对命令字符串写 regex 必然漏。
// 因此先把语句解析成 { 规范 cmdlet 名, 规范参数集, 目标参数 } 再跑规则，
// 别名/缩写变体在规范化层消化，规则只写规范名。
//
// 与 posix 规则（commandSafety.ts / commandPolicy.ts）的关系：
// - 本模块只新增 Windows 形态的检测，posix 模式在 Windows 上照常运行
//   （覆盖 Git-Bash / 显式调 bash 的场景），两包叠加。
// - 硬毙（block）任何安全模式下都拦；分级（danger）供 validateCommand 合并。

export type WindowsRiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export interface WindowsBlockDecision {
  blocked: boolean;
  flag?: string;
  reason?: string;
}

export interface WindowsDangerFinding {
  riskLevel: WindowsRiskLevel;
  flag: string;
  reason: string;
  suggestion?: string;
}

// ----------------------------------------------------------------------------
// 规范化层：别名、参数前缀、语句拆分
// ----------------------------------------------------------------------------

/** PowerShell 内置别名 → 规范 cmdlet 名（小写）。curl/wget 在 PS 5.1 是 iwr 别名。 */
const CMDLET_ALIASES: Record<string, string> = {
  rm: 'remove-item', del: 'remove-item', erase: 'remove-item',
  rd: 'remove-item', ri: 'remove-item', rmdir: 'remove-item',
  ls: 'get-childitem', dir: 'get-childitem', gci: 'get-childitem',
  cat: 'get-content', gc: 'get-content', type: 'get-content',
  cp: 'copy-item', copy: 'copy-item', cpi: 'copy-item',
  mv: 'move-item', move: 'move-item', mi: 'move-item',
  iex: 'invoke-expression',
  iwr: 'invoke-webrequest', curl: 'invoke-webrequest', wget: 'invoke-webrequest',
  irm: 'invoke-restmethod',
  saps: 'start-process', start: 'start-process',
  spps: 'stop-process', kill: 'stop-process',
  sp: 'set-itemproperty',
  sc: 'set-content',
  ni: 'new-item',
  echo: 'write-output', write: 'write-output',
  pwd: 'get-location', gl: 'get-location',
};

/**
 * 危险相关参数的规范名。PowerShell 接受任意无歧义前缀（-Recurse 可写 -r），
 * 安全匹配方向上宁可过匹配：token 是其中某个名字的前缀即展开为该规范名。
 */
const DANGEROUS_PARAM_NAMES = ['recurse', 'force', 'encodedcommand', 'executionpolicy'];

interface WinStatement {
  /** 规范 cmdlet 名（别名展开、去路径/.exe 后缀、小写） */
  cmd: string;
  /** 规范化参数集（-r → recurse；cmd 风格 /s /q /f 也归一进来） */
  params: Set<string>;
  /** 非参数 token（小写、去引号）——通常是操作目标 */
  targets: string[];
  /** 原始语句（小写） */
  raw: string;
}

/** cmd.exe 开关 → 等价规范参数（rd /s ≈ -recurse，del /f ≈ -force） */
const CMD_SWITCH_MAP: Record<string, string> = {
  '/s': 'recurse',
  '/q': 'force',
  '/f': 'force',
};

function stripQuotes(token: string): string {
  return token.replace(/^["']|["']$/g, '');
}

/** 去掉路径前缀与 .exe/.com/.bat/.cmd 后缀：C:\Windows\System32\reg.exe → reg */
function canonicalProgramName(token: string): string {
  const base = stripQuotes(token).toLowerCase().split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(exe|com|bat|cmd|ps1)$/, '');
}

function canonicalizeParam(token: string): string {
  const lower = token.toLowerCase();
  const name = lower.replace(/^[-/]+/, '').replace(/[:=].*$/, '');
  if (lower.startsWith('/') && CMD_SWITCH_MAP[lower]) return CMD_SWITCH_MAP[lower];
  if (lower.startsWith('-') && name.length > 0) {
    const matches = DANGEROUS_PARAM_NAMES.filter((p) => p.startsWith(name));
    // 唯一前缀 → 展开；歧义前缀（如 -e 同时是 encodedcommand/executionpolicy 前缀）
    // 按安全方向展开为 encodedcommand（powershell.exe 实际也把 -e 解析为它）
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 && matches.includes('encodedcommand')) return 'encodedcommand';
  }
  return name;
}

/** 引号感知地按 ; | && || 与换行拆语句 */
function splitWindowsStatements(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }
    if (!inSingle && !inDouble) {
      if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
        parts.push(current); current = ''; i += 2; continue;
      }
      if (ch === ';' || ch === '|' || ch === '\n') {
        parts.push(current); current = ''; i++; continue;
      }
    }
    current += ch;
    i++;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function tokenize(statement: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of statement) {
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseStatement(raw: string): WinStatement | null {
  const tokens = tokenize(raw.trim());
  if (tokens.length === 0) return null;
  const program = canonicalProgramName(tokens[0]);
  const cmd = CMDLET_ALIASES[program] ?? program;
  const params = new Set<string>();
  const targets: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-') || /^\/[a-z]+$/i.test(token)) {
      params.add(canonicalizeParam(token));
    } else {
      targets.push(stripQuotes(token).toLowerCase());
    }
  }
  return { cmd, params, targets, raw: raw.toLowerCase() };
}

/**
 * 解析整条命令为语句列表；`cmd /c "..."` 与 `powershell -Command "..."`
 * 各解一层包裹（嵌套套娃由 encodedcommand / 深度限制兜底）。
 */
export function parseWindowsCommand(command: string, depth = 0): WinStatement[] {
  if (depth > 2) return [];
  const statements: WinStatement[] = [];
  for (const part of splitWindowsStatements(command)) {
    const stmt = parseStatement(part);
    if (!stmt) continue;
    statements.push(stmt);
    // cmd /c <rest>：把 rest 当内层命令再解析
    if (stmt.cmd === 'cmd') {
      const tokens = tokenize(part);
      const flagIdx = tokens.findIndex((t) => /^\/[ck]$/i.test(t));
      if (flagIdx >= 0 && flagIdx + 1 < tokens.length) {
        const inner = stripQuotes(tokens.slice(flagIdx + 1).join(' '));
        statements.push(...parseWindowsCommand(inner, depth + 1));
      }
    }
    // powershell -Command <rest>
    if (stmt.cmd === 'powershell' || stmt.cmd === 'pwsh') {
      const tokens = tokenize(part);
      const flagIdx = tokens.findIndex((t) => /^-c(ommand)?$/i.test(t));
      if (flagIdx >= 0 && flagIdx + 1 < tokens.length) {
        const inner = stripQuotes(tokens.slice(flagIdx + 1).join(' '));
        statements.push(...parseWindowsCommand(inner, depth + 1));
      }
    }
  }
  return statements;
}

// ----------------------------------------------------------------------------
// 保护根目录判定
// ----------------------------------------------------------------------------

/** 删除时硬毙的目标：盘根、用户主目录（整个）、系统目录 */
function isProtectedRoot(target: string): boolean {
  const t = target.replace(/["']/g, '').replace(/[\\/]+$/, '').toLowerCase();
  if (/^[a-z]:$/.test(t)) return true;                                  // C:\ 盘根
  if (t === '~' || t === '$home' || t === '$env:userprofile') return true;
  if (/^[a-z]:[\\/](users|windows|programdata|program files( \(x86\))?)$/.test(t)) return true;
  if (/^[a-z]:[\\/]users[\\/][^\\/]+$/.test(t)) return true;            // 整个用户主目录
  if (/^[a-z]:[\\/]windows[\\/]/.test(t)) return true;                  // 系统目录内部
  return false;
}

// ----------------------------------------------------------------------------
// 硬毙清单（任何安全模式下都拦，windows-support.md §3.2 ②）
// ----------------------------------------------------------------------------

type BlockRule = (stmt: WinStatement) => WindowsBlockDecision | null;

const BLOCK_RULES: BlockRule[] = [
  // 删除保护根（Remove-Item 及全部别名 + cmd rd/del，经规范化后统一命中）
  (stmt) => {
    if (stmt.cmd !== 'remove-item') return null;
    const hit = stmt.targets.find(isProtectedRoot);
    if (!hit) return null;
    return { blocked: true, flag: 'win_root_delete', reason: `删除保护目录（${hit}）` };
  },
  // 格式化磁盘
  (stmt) => (stmt.cmd === 'format'
    ? { blocked: true, flag: 'win_format_disk', reason: '格式化磁盘（format）' }
    : null),
  // 删除卷影副本（勒索软件标志动作）
  (stmt) => (stmt.cmd === 'vssadmin' && stmt.raw.includes('delete') && stmt.raw.includes('shadow')
    ? { blocked: true, flag: 'win_shadow_delete', reason: '删除卷影副本（vssadmin delete shadows）' }
    : null),
  // 引导配置篡改（放行只读 /enum /v）
  (stmt) => {
    if (stmt.cmd !== 'bcdedit') return null;
    const readonly = stmt.targets.length === 0
      && [...stmt.params].every((p) => p === 'enum' || p === 'v');
    return readonly ? null : { blocked: true, flag: 'win_boot_tamper', reason: '修改引导配置（bcdedit）' };
  },
  // diskpart 整体拦（交互式磁盘工具，无安全子集）
  (stmt) => (stmt.cmd === 'diskpart'
    ? { blocked: true, flag: 'win_diskpart', reason: '磁盘分区工具（diskpart）' }
    : null),
  // 编码命令（base64 整段命令，规则层不可见 → 直接拒）
  (stmt) => ((stmt.cmd === 'powershell' || stmt.cmd === 'pwsh') && stmt.params.has('encodedcommand')
    ? { blocked: true, flag: 'win_encoded_command', reason: '编码命令（-EncodedCommand）不可审计' }
    : null),
  // 执行策略绕过
  (stmt) => (stmt.cmd === 'set-executionpolicy'
    && stmt.targets.some((t) => t === 'bypass' || t === 'unrestricted')
    ? { blocked: true, flag: 'win_execpolicy_bypass', reason: '绕过脚本执行策略（Set-ExecutionPolicy Bypass）' }
    : null),
  // HKLM 注册表删除
  (stmt) => {
    const hklmTarget = stmt.targets.some((t) => t.startsWith('hklm') || t.startsWith('hkey_local_machine'));
    if (stmt.cmd === 'reg' && stmt.targets.includes('delete') && hklmTarget) {
      return { blocked: true, flag: 'win_reg_delete_hklm', reason: '删除系统注册表项（reg delete HKLM）' };
    }
    if ((stmt.cmd === 'remove-item' || stmt.cmd === 'remove-itemproperty') && hklmTarget) {
      return { blocked: true, flag: 'win_reg_delete_hklm', reason: '删除系统注册表项（HKLM:）' };
    }
    return null;
  },
  // 关机/重启
  (stmt) => (['stop-computer', 'restart-computer', 'shutdown'].includes(stmt.cmd)
    ? { blocked: true, flag: 'win_system_shutdown', reason: '关机/重启命令' }
    : null),
];

/** 下载执行组合：iex/invoke-expression 与下载源出现在同一条命令 → 硬毙 */
function checkDownloadExecCombo(statements: WinStatement[], rawCommand: string): WindowsBlockDecision | null {
  const hasIex = statements.some((s) => s.cmd === 'invoke-expression')
    || /\|\s*iex\b/i.test(rawCommand);
  if (!hasIex) return null;
  const hasDownload = statements.some((s) => s.cmd === 'invoke-webrequest' || s.cmd === 'invoke-restmethod')
    || /downloadstring|downloadfile|net\.webclient|start-bitstransfer/i.test(rawCommand);
  if (!hasDownload) return null;
  return { blocked: true, flag: 'win_remote_exec', reason: '下载并执行远程脚本（iex + 下载源）' };
}

export function checkWindowsBlockRules(command: string): WindowsBlockDecision {
  const trimmed = command.trim();
  if (!trimmed) return { blocked: false };
  const statements = parseWindowsCommand(trimmed);
  for (const stmt of statements) {
    for (const rule of BLOCK_RULES) {
      const decision = rule(stmt);
      if (decision) return decision;
    }
  }
  const combo = checkDownloadExecCombo(statements, trimmed);
  if (combo) return combo;
  return { blocked: false };
}

// ----------------------------------------------------------------------------
// 分级危险清单（高危 confirm 档，windows-support.md §3.2 ③）
// ----------------------------------------------------------------------------

type DangerRule = (stmt: WinStatement) => WindowsDangerFinding | null;

const DANGER_RULES: DangerRule[] = [
  // 递归/强制删除（非保护根——保护根已在 BLOCK 层拦掉）
  (stmt) => (stmt.cmd === 'remove-item' && (stmt.params.has('recurse') || stmt.params.has('force'))
    ? {
        riskLevel: 'high', flag: 'win_recursive_delete',
        reason: '递归/强制删除目标路径',
        suggestion: '确认具体目标；可考虑回收站而非直接删除',
      }
    : null),
  // 计划任务持久化
  (stmt) => ((stmt.cmd === 'schtasks' && stmt.params.has('create'))
    || stmt.cmd === 'register-scheduledtask' || stmt.cmd === 'new-scheduledtask'
    ? { riskLevel: 'high', flag: 'win_scheduled_task', reason: '创建计划任务（持久化）' }
    : null),
  // 防火墙/网络配置
  (stmt) => (stmt.cmd === 'netsh'
    ? {
        riskLevel: stmt.raw.includes('firewall') ? 'high' : 'medium',
        flag: 'win_netsh', reason: '修改网络/防火墙配置（netsh）',
      }
    : null),
  // ACL 放权 / 夺取所有权
  (stmt) => (stmt.cmd === 'icacls' && stmt.raw.includes('/grant')
    ? { riskLevel: 'high', flag: 'win_acl_grant', reason: '修改文件 ACL 授权（icacls /grant）' }
    : null),
  (stmt) => (stmt.cmd === 'takeown'
    ? { riskLevel: 'high', flag: 'win_takeown', reason: '夺取文件所有权（takeown）' }
    : null),
  // 注册表写入
  (stmt) => {
    const regTarget = stmt.targets.some((t) => /^hk(lm|cu|ey_)/.test(t));
    if (stmt.cmd === 'reg' && stmt.targets.includes('add')) {
      return {
        riskLevel: stmt.targets.some((t) => t.startsWith('hklm')) ? 'high' : 'medium',
        flag: 'win_reg_write', reason: '写入注册表（reg add）',
      };
    }
    if ((stmt.cmd === 'set-itemproperty' || stmt.cmd === 'new-itemproperty') && regTarget) {
      return { riskLevel: 'high', flag: 'win_reg_write', reason: '写入注册表（*-ItemProperty HK*）' };
    }
    return null;
  },
  // 服务安装
  (stmt) => (stmt.cmd === 'new-service' || (stmt.cmd === 'sc' && stmt.targets.includes('create'))
    ? { riskLevel: 'high', flag: 'win_service_install', reason: '安装系统服务' }
    : null),
  // Defender 干预
  (stmt) => (stmt.cmd === 'set-mppreference' || stmt.cmd === 'add-mppreference'
    ? { riskLevel: 'high', flag: 'win_defender_tamper', reason: '修改 Defender 配置' }
    : null),
  // 强杀进程
  (stmt) => ((stmt.cmd === 'stop-process' && stmt.params.has('force'))
    || (stmt.cmd === 'taskkill' && stmt.params.has('force'))
    ? { riskLevel: 'medium', flag: 'win_kill_force', reason: '强制结束进程' }
    : null),
  // 剩余空间擦除（耗时 + 不可逆语义）
  (stmt) => (stmt.cmd === 'cipher' && stmt.raw.includes('/w')
    ? { riskLevel: 'high', flag: 'win_cipher_wipe', reason: '擦除磁盘剩余空间（cipher /w）' }
    : null),
  // 以绕过执行策略方式启动 PowerShell（Set-ExecutionPolicy 持久绕过在 BLOCK 层）
  (stmt) => ((stmt.cmd === 'powershell' || stmt.cmd === 'pwsh') && stmt.params.has('executionpolicy')
    && stmt.targets.some((t) => t === 'bypass' || t === 'unrestricted')
    ? { riskLevel: 'high', flag: 'win_execpolicy_bypass_arg', reason: '以绕过执行策略方式启动 PowerShell' }
    : null),
];

export function evaluateWindowsDanger(command: string): WindowsDangerFinding[] {
  const trimmed = command.trim();
  if (!trimmed) return [];
  const findings: WindowsDangerFinding[] = [];
  const seen = new Set<string>();
  for (const stmt of parseWindowsCommand(trimmed)) {
    for (const rule of DANGER_RULES) {
      const finding = rule(stmt);
      if (finding && !seen.has(finding.flag)) {
        seen.add(finding.flag);
        findings.push(finding);
      }
    }
  }
  return findings;
}

// ----------------------------------------------------------------------------
// 安全白名单（PowerShell 只读 cmdlet，供 isKnownSafeCommand 走 powershell 分支）
// ----------------------------------------------------------------------------

const WINDOWS_SAFE_CMDLETS = new Set([
  'get-childitem', 'get-content', 'get-location', 'get-item', 'get-itemproperty',
  'get-date', 'get-process', 'get-service', 'get-command', 'get-help', 'get-host',
  'get-member', 'get-variable', 'get-history', 'get-alias', 'get-psdrive',
  'test-path', 'resolve-path', 'split-path', 'join-path',
  'select-string', 'select-object', 'sort-object', 'measure-object', 'compare-object',
  'where-object', 'group-object',
  'format-table', 'format-list', 'out-string', 'write-output', 'write-host',
  'measure-command', 'hostname', 'whoami', 'ver', 'systeminfo', 'tasklist',
]);

/**
 * PowerShell 语句级安全判断：每条语句的规范 cmdlet 都在白名单内才算安全。
 * posixSafeSet 兜底（ls/cat/grep 等 POSIX 名在 PS 里多为只读别名，且已被
 * 别名展开消化——这里收的是规范化后仍未命中的原名，如 jq/rg 等外部只读工具）。
 */
export function isKnownSafeWindowsCommand(command: string, posixSafeSet: ReadonlySet<string>): boolean {
  const statements = parseWindowsCommand(command.trim());
  if (statements.length === 0) return false;
  for (const stmt of statements) {
    if (WINDOWS_SAFE_CMDLETS.has(stmt.cmd)) continue;
    if (posixSafeSet.has(stmt.cmd)) continue;
    return false;
  }
  return true;
}

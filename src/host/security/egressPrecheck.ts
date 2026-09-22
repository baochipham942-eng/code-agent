// ============================================================================
// Egress Precheck — ADR-066 D5 刀 0：bash 出网命令的文本预检。
//
// 从 curl/wget/nc/ncat/netcat/ssh/scp 的字面 argv 抽 URL/host（继承 commandParse
// 的 wrapper 解包：一层 bash -c、sudo/command/env、深度 4；同行赋值 NAME=literal
// 回填 $NAME 后再抽），喂 ssrfGuard.isPrivateOrLocalHost。
//
// 两种发现（刀 0 都只供 commandSafety 升 high 确认，不硬毙；硬拒绝在刀 3 代理侧）：
// - private-host：抽到字面 host 且命中私网/环回/链路本地/元数据。
// - unresolvable-target：确认网络命令在场而目的地解析不出字面——$VAR/$(...)、
//   xargs 管道喂入、curl -K 配置文件、wrapper 套娃超深、parser uncertain/failed。
//   边界：只有确认 7 个工具之一在场才报，不把所有 uncertain bash 都升级。
// ============================================================================

import * as path from 'node:path';
import { lenientCommandWords, parseShellCommand, type ShellExecution } from './commandParse';
import { isPrivateOrLocalHost } from './ssrfGuard';

// 抽取名单（ADR-066 D5）：nc/ncat/netcat 只进本名单，不改 sandbox 的 NETWORK_COMMANDS。
const EGRESS_TOOLS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp']);

export type EgressPrecheckFinding =
  | { kind: 'private-host'; tool: string; host: string }
  | { kind: 'unresolvable-target'; tool: string };

interface ToolSpec {
  /** 吃一个值（`--opt v` / `--opt=v` / `-oV`）的选项；值整体跳过不当 host。 */
  valueOptions: ReadonlySet<string>;
  /** 值本身就是目标 URL 的选项（curl --url）。 */
  targetValueOptions?: ReadonlySet<string>;
  /** 目标可能来自文件的选项（curl -K/--config）→ 直接判不可解析。 */
  configOptions?: ReadonlySet<string>;
  /** 哪些 operand 是 host 候选：ssh 只有首个 operand 是目标，之后是远端命令。 */
  operandHosts: 'all' | 'first';
}

// 只列「吃值」的选项：未知 dash 词整体跳过，其值若被误读为 operand 最多偏严，
// 而已知吃值选项若不跳过，其值（如 -x http://127.0.0.1:7897 的本地代理）会误报私网。
const CURL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-o', '--output', '--output-dir', '-w', '--write-out',
  '-d', '--data', '--data-raw', '--data-ascii', '--data-binary', '--data-urlencode', '--json',
  '-H', '--header', '--proxy-header', '-A', '--user-agent', '-e', '--referer',
  '-b', '--cookie', '-c', '--cookie-jar',
  '-u', '--user', '-U', '--proxy-user', '-x', '--proxy', '--preproxy', '--proxy1.0',
  '-F', '--form', '--form-string', '-T', '--upload-file', '-X', '--request', '--request-target',
  '--resolve', '--connect-to', '--doh-url', '--alt-svc', '--hsts',
  '--cacert', '--capath', '--cert', '-E', '--cert-type', '--key', '--key-type', '--pass',
  '--crlfile', '--pinnedpubkey', '--engine', '--ciphers', '--tls13-ciphers', '--curves',
  '--pubkey', '--hostpubmd5', '--hostpubsha256', '--ssl-allow-beast',
  '--interface', '--dns-interface', '--dns-ipv4-addr', '--dns-ipv6-addr', '--dns-servers',
  '--local-port', '--unix-socket', '--abstract-unix-socket',
  '--limit-rate', '--speed-limit', '-Y', '--speed-time', '-y', '--keepalive-time',
  '-m', '--max-time', '--connect-timeout', '--expect100-timeout', '--happy-eyeballs-timeout-ms',
  '--retry', '--retry-delay', '--retry-max-time', '--max-filesize', '--max-redirs',
  '--range', '-r', '--time-cond', '-z',
  '--ftp-account', '--ftp-alternative-to-user', '--service-name', '--proxy-service-name',
  '--oauth2-bearer', '--aws-sigv4', '--delegation', '--sasl-authzid', '--login-options',
  '--mail-from', '--mail-rcpt', '--mail-auth',
  '--proto', '--proto-redir', '--proto-default', '--ip-tos', '--vlan-priority',
  '--create-file-mode', '--dump-header', '-D', '--stderr', '--trace', '--trace-ascii',
  '--trace-config', '--etag-save', '--etag-compare', '--netrc-file',
  '--parallel-max', '--rate', '--tftp-blksize', '--url-query', '--variable', '--ech',
]);

const WGET_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-O', '--output-document', '-o', '--output-file', '-a', '--append-output',
  '-P', '--directory-prefix', '--default-page', '--cut-dirs', '-l', '--level',
  '--post-data', '--post-file', '--method', '--body-data', '--body-file', '--header',
  '--user', '--password', '--ftp-user', '--ftp-password', '--http-user', '--http-password',
  '--proxy-user', '--proxy-password', '--load-cookies', '--save-cookies',
  '-U', '--user-agent', '--referer', '--secure-protocol',
  '--ca-certificate', '--ca-directory', '--certificate', '--certificate-type',
  '--private-key', '--private-key-type', '--random-file', '--egd-file', '--crl-file',
  '-t', '--tries', '-T', '--timeout', '--dns-timeout', '--connect-timeout', '--read-timeout',
  '--wait', '--waitretry', '--bind-address', '--limit-rate', '--quota',
  '-e', '--execute', '--config', '-X', '--exclude-directories', '-I', '--include-directories',
  '-A', '--accept', '-R', '--reject', '--accept-regex', '--reject-regex',
  '-D', '--domains', '--exclude-domains', '--follow-tags', '--ignore-tags',
  '--warc-file', '--warc-tempdir', '--progress', '--report-speed', '--compression',
]);

const NC_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-p', '-s', '-x', '-X', '-i', '-w', '-q', '-e', '-c', '-g', '-G',
  '-o', '--output', '--hex-dump', '--proxy', '--proxy-type', '--proxy-auth',
  '--source-addr', '--source-port', '--exec', '--sh-exec', '--lua-exec',
  '--ssl-cert', '--ssl-key', '--ssl-trustfile', '--ssl-ciphers', '--ssl-servername',
  '--delay', '--wait', '--con-timeout', '--idle-timeout',
]);

// ssh：-L/-R/-D/-W 的转发规格是值不是连接目标（转发内网目的地归刀 3，刀 0 不展开）。
const SSH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m',
  '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w',
]);

const SCP_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-P', '-c', '-F', '-i', '-J', '-l', '-o', '-S',
]);

const TOOL_SPECS: Record<string, ToolSpec> = {
  curl: {
    valueOptions: CURL_VALUE_OPTIONS,
    targetValueOptions: new Set(['--url']),
    configOptions: new Set(['-K', '--config']),
    operandHosts: 'all',
  },
  wget: { valueOptions: WGET_VALUE_OPTIONS, operandHosts: 'all' },
  nc: { valueOptions: NC_VALUE_OPTIONS, operandHosts: 'all' },
  ncat: { valueOptions: NC_VALUE_OPTIONS, operandHosts: 'all' },
  netcat: { valueOptions: NC_VALUE_OPTIONS, operandHosts: 'all' },
  ssh: { valueOptions: SSH_VALUE_OPTIONS, operandHosts: 'first' },
  scp: { valueOptions: SCP_VALUE_OPTIONS, operandHosts: 'all' },
};

function basenameOf(program: string): string {
  return path.posix.basename(program.replaceAll('\\', '/'));
}

const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function hostFromUrlToken(token: string): string | null {
  try {
    return new URL(token).hostname || null;
  } catch {
    return null;
  }
}

/**
 * 裸 host 词（无 scheme）：可带 user@ 前缀、:port 或 scp 的 :path 后缀、IPv6 方括号。
 * 只接受形状干净的 host——含空格/逗号/= 等的值类词（header、data）在此被拒之门外。
 */
function hostFromBareToken(token: string): string | null {
  let rest = token.includes('@') ? token.slice(token.lastIndexOf('@') + 1) : token;
  if (!rest) return null;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0) return null;
    const tail = rest.slice(end + 1);
    if (tail !== '' && !tail.startsWith(':')) return null;
    return rest.slice(0, end + 1);
  }
  const colonCount = (rest.match(/:/g) ?? []).length;
  if (colonCount > 1) {
    // 多冒号只可能是裸 IPv6（::1、fe80::1），不做端口剥离
    return /^[0-9a-fA-F.:]+$/.test(rest) && rest.includes(':') ? rest : null;
  }
  if (colonCount === 1) {
    // host:port 或 scp 的 host:path——冒号前才是 host
    rest = rest.slice(0, rest.indexOf(':'));
  }
  if (rest === 'localhost') return rest;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return rest;
  if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(rest)) {
    return rest;
  }
  return null;
}

interface TargetScan {
  hosts: string[];
  dynamic: boolean;
  configFile: boolean;
}

function scanToolArgv(spec: ToolSpec, args: string[]): TargetScan {
  const hosts: string[] = [];
  let dynamic = false;
  let configFile = false;
  let optionsRegion = true;
  let operandIndex = 0;

  const considerTarget = (token: string): void => {
    // $VAR / $(...) / 反引号残留在目标位置 → 目的地对文本不可见
    if (/[$`]/.test(token)) {
      dynamic = true;
      return;
    }
    if (SCHEME_PREFIX.test(token)) {
      const host = hostFromUrlToken(token);
      if (host) hosts.push(host);
      return;
    }
    const host = hostFromBareToken(token);
    if (host) hosts.push(host);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsRegion && arg === '--') {
      optionsRegion = false;
      continue;
    }
    if (optionsRegion && arg.startsWith('-') && arg !== '-') {
      const name = arg.split('=', 1)[0];
      const shortHead = !arg.startsWith('--') && arg.length >= 2 ? arg.slice(0, 2) : null;
      if (spec.configOptions?.has(name) || (shortHead !== null && spec.configOptions?.has(shortHead))) {
        configFile = true;
      }
      if (spec.targetValueOptions?.has(name)) {
        const value = arg.includes('=') ? arg.slice(name.length + 1) : args[++index];
        if (value !== undefined) considerTarget(value);
        continue;
      }
      if (spec.valueOptions.has(name) && arg === name) {
        // 贴值形式（-oFILE / --opt=val）是单 token 整体跳过；只有裸选项才吃下一个词
        index += 1;
        continue;
      }
      continue;
    }
    if (spec.operandHosts === 'first' && operandIndex > 0) {
      operandIndex += 1;
      continue;
    }
    operandIndex += 1;
    considerTarget(arg);
  }
  return { hosts, dynamic, configFile };
}

/**
 * 同行/前段赋值的字面回填：`URL=http://… curl $URL` 里 parser 在
 * environmentAssignments 上保留了字面，整词恰为 $NAME/${NAME} 时换成字面值再抽。
 * 值含 $ / 反引号的不回填（它不是字面），嵌在更长文本里的引用留给 dynamic 判据。
 */
function substituteAssignments(execution: ShellExecution): string[] {
  const vars = new Map<string, string>();
  for (const assignment of execution.environmentAssignments ?? []) {
    const eq = assignment.indexOf('=');
    if (eq <= 0) continue;
    const value = assignment.slice(eq + 1);
    if (!/[$`]/.test(value)) vars.set(assignment.slice(0, eq), value);
  }
  return execution.args.map((arg) => {
    const match = arg.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
    if (!match) return arg;
    return vars.get(match[1] ?? match[2] ?? '') ?? arg;
  });
}

const LENIENT_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const LENIENT_WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'exec', 'nohup', 'setsid', 'env', 'xargs',
  'nice', 'timeout', 'time', 'busybox',
]);
const LENIENT_SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&', '\n', '$(', '`', '(', ')']);
const LENIENT_REDIRECTS = new Set(['>', '>>', '>&', '<', '<<', '<<<', '<&', '<>', '>|']);
// 比 parser 的 wrapper 深度 4 多一倍：parser 超深失败时，兜底扫描仍要能看到套娃里的工具名。
const MAX_LENIENT_DEPTH = 8;

/**
 * 解析失败/不确定时的偏严兜底：只在「命令位置」认网络工具——句首、分隔符后、
 * 已知 wrapper/shell 之后——`echo "curl $(date)"` 这类散文/数据里的同名词不算在场。
 * shell -c 的脚本文本递归扫，罩住 wrapper 套娃超深的形状。不做端口/选项级理解。
 */
function egressToolsFromLenient(command: string): Set<string> {
  const found = new Set<string>();
  const walk = (words: string[], depth: number): void => {
    if (depth > MAX_LENIENT_DEPTH) return;
    let commandPosition = true;
    let inShellOptions = false;
    let scriptNext = false;
    for (const word of words) {
      if (LENIENT_SEPARATORS.has(word)) {
        commandPosition = true;
        inShellOptions = false;
        scriptNext = false;
        continue;
      }
      if (LENIENT_REDIRECTS.has(word)) {
        commandPosition = false;
        inShellOptions = false;
        scriptNext = false;
        continue;
      }
      if (scriptNext) {
        walk(lenientCommandWords(word), depth + 1);
        commandPosition = false;
        inShellOptions = false;
        scriptNext = false;
        continue;
      }
      if (!commandPosition) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      if (inShellOptions && word.startsWith('-')) {
        // bash 的启动选项；含 c 的簇（-c / -lc / -O 前的形态见 commandParse.shellScript）
        if (word === '-c' || /^-[^-]*c[^-]*$/.test(word)) {
          scriptNext = true;
          inShellOptions = false;
        }
        continue;
      }
      if (commandPosition && word.startsWith('-')) continue; // wrapper 的选项，命令还在后面
      const name = basenameOf(word);
      if (EGRESS_TOOLS.has(name)) found.add(name);
      if (LENIENT_SHELLS.has(name)) {
        inShellOptions = true;
        continue;
      }
      if (LENIENT_WRAPPERS.has(name)) continue;
      commandPosition = false;
      inShellOptions = false;
    }
  };
  walk(lenientCommandWords(command), 0);
  return found;
}

/**
 * 整条命令的出网预检。返回首个发现：字面私网 host 优先（reason 更好），
 * 其次是「网络命令在场而目的地不可解析」的偏严升级。
 */
export function assessEgressPrecheck(command: string): EgressPrecheckFinding | null {
  const parsed = parseShellCommand(command);
  let privateHost: EgressPrecheckFinding | null = null;
  let unresolvable: EgressPrecheckFinding | null = null;
  // 目标已干净解析（≥1 个字面 host、无动态/配置文件/stdin 喂入）的工具——
  // parser 层面的 uncertain/failed 来自别的段时，不株连已解析清楚的网络命令。
  const resolvedTools = new Set<string>();

  for (const execution of parsed.executions) {
    const tool = basenameOf(execution.program);
    const spec = TOOL_SPECS[tool];
    if (!spec) continue;
    const scan = scanToolArgv(spec, substituteAssignments(execution));
    const privateHit = scan.hosts.find((host) => isPrivateOrLocalHost(host));
    if (privateHit) {
      privateHost ??= { kind: 'private-host', tool, host: privateHit };
      continue;
    }
    const stdinFed = execution.wrappers.some((wrapper) => basenameOf(wrapper) === 'xargs');
    if (scan.dynamic || scan.configFile || stdinFed) {
      unresolvable ??= { kind: 'unresolvable-target', tool };
      continue;
    }
    if (scan.hosts.length > 0) resolvedTools.add(tool);
  }

  if (privateHost) return privateHost;

  if (parsed.parsingFailed || parsed.uncertain.length > 0) {
    for (const tool of egressToolsFromLenient(command)) {
      if (resolvedTools.has(tool)) continue;
      unresolvable ??= { kind: 'unresolvable-target', tool };
    }
  }

  return unresolvable;
}

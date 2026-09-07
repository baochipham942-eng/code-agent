import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ToolDefinition,
  ToolPathAuthorityDescriptor,
  ToolPathMutationKind,
} from '../../shared/contract';
import { getMemoryDir } from '../lightMemory/indexLoader';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { canonicalizeCommand, ANSI_C_ESCAPES } from '../security/canonicalizeCommand';

export interface ResolveToolWriteTargetsInput {
  definition: ToolDefinition;
  params: Record<string, unknown>;
  workingDirectory: string;
  agentRole?: string;
}

export interface ToolWriteTargets {
  targets: string[];
  uncertain: string[];
  mutations: Record<string, ToolPathMutationKind>;
}

const PATH_LIKE_SUFFIXES = new Set(['file', 'path', 'directory', 'destination', 'target']);

function isPathLikeParameter(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return PATH_LIKE_SUFFIXES.has(normalized.split('_').at(-1) ?? '');
}

function resolveToolPath(rawPath: string, workingDirectory: string): string {
  const expanded = rawPath === '~'
    ? os.homedir()
    : rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.slice(2))
      : rawPath;
  return resolveCanonicalRunPath(
    path.isAbsolute(expanded) ? expanded : path.resolve(workingDirectory, expanded),
  );
}

function readShellWord(command: string, start: number): { raw: string; end: number } {
  let index = start;
  while (index < command.length && /\s/.test(command[index])) index += 1;
  const wordStart = index;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char) || char === ';' || char === '|' || char === '&' || char === '>' || char === '<') break;
  }
  return { raw: command.slice(wordStart, index), end: index };
}

/**
 * `$'...'`（ANSI-C 引用）里一个 `\` 转义序列的解码。转义字母表从 canonicalizeCommand
 * import（同一份，别另抄）；`\xHH`/`\uHHHH`/`\UHHHHHHHH`/八进制的消费规则照它那边的
 * ansi 档。返回 undefined = 非法/截断，调用方原样保留反斜杠。
 */
function readAnsiCEscape(word: string, index: number): { value: string; end: number } | undefined {
  const escaped = word[index + 1];
  if (escaped === undefined) return undefined;
  const named = ANSI_C_ESCAPES[escaped];
  if (named !== undefined) return { value: named, end: index + 1 };
  const isUnicode = escaped === 'u' || escaped === 'U';
  const encoded = escaped === 'x'
    ? word.slice(index + 2).match(/^[0-9a-fA-F]{1,2}/)?.[0]
    : escaped === 'u'
      ? word.slice(index + 2).match(/^[0-9a-fA-F]{1,4}/)?.[0]
      : escaped === 'U'
        ? word.slice(index + 2).match(/^[0-9a-fA-F]{1,8}/)?.[0]
        : word.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
  if (encoded === undefined) return { value: escaped, end: index + 1 }; // 未识别字母：照 canonicalize 原样取该字符
  const radix = escaped === 'x' || isUnicode ? 16 : 8;
  const codePoint = Number.parseInt(encoded, radix);
  if (isUnicode && codePoint > 0x10ffff) return undefined;
  return {
    value: isUnicode ? String.fromCodePoint(codePoint) : String.fromCharCode(codePoint),
    end: index + encoded.length + (radix === 16 ? 1 : 0),
  };
}

/**
 * 词法值化（bash 词义）：去引号（可跨段、可只在词中）+ 解反斜杠转义 + 解 `$'...'` ANSI-C。
 * unquote 只够剥整词引号；`"/tmp/a b"`、`/tmp/a\ b`、`re"port".txt`、`$'\x72eport.txt'`
 * 这些形状要逐字符走（PR #1709 复审① + commandCanonicalization 的跨形等价钉）。
 * 双引号内 `\` 只转义 $ ` " \（照 canonicalizeCommand 的 double 档）；`$(`/反引号不解——
 * 含 $ ` * ? { } 的目标下游一律打 uncertain，不用在这里抠动态替换语义。
 */
function shellWordValue(word: string): string {
  let value = '';
  let quote: "'" | '"' | undefined;
  let ansi = false;
  for (let index = 0; index < word.length; index += 1) {
    const char = word[index];
    if (quote === "'") {
      if (char === "'") { quote = undefined; ansi = false; continue; }
      if (ansi && char === '\\') {
        const decoded = readAnsiCEscape(word, index);
        if (decoded) { value += decoded.value; index = decoded.end; continue; }
      }
      value += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') { quote = undefined; continue; }
      if (char === '\\' && ['$', '`', '"', '\\'].includes(word[index + 1] ?? '')) {
        value += word[index + 1];
        index += 1;
        continue;
      }
      value += char;
      continue;
    }
    if (char === '$' && word[index + 1] === "'") { quote = "'"; ansi = true; index += 1; continue; }
    if (char === '$' && word[index + 1] === '"') { quote = '"'; index += 1; continue; }
    if (char === '\\') {
      const next = word[index + 1];
      if (next === undefined) { value += char; break; }
      value += next;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; ansi = false; continue; }
    value += char;
  }
  return value;
}

interface ShellToken {
  kind: 'word' | 'redirect' | 'separator';
  raw: string;
}

/**
 * 把 shell 命令切成词 / 重定向目标 / 命令分隔符，引号与转义感知。
 * 两类写入载体共用这一个解析：`>`/`>>` 重定向，和 cp / mv / tee 的目标位。
 */
function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    // 换行必须先于空白判断：`/\s/` 认得 '\n'，先走空白分支就把命令边界吞掉了，
    // 多行脚本的第 2 行起会跟第 1 行粘成一条命令（ai-review PR #1650 第 3 轮）。
    if (char === '\n' || char === '\r' || char === ';') {
      tokens.push({ kind: 'separator', raw: char });
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    // `&>` / `&>>` 是重定向，其余的 `&` 与 `|` 都是命令边界。
    if ((char === '|') || (char === '&' && command[index + 1] !== '>')) {
      tokens.push({ kind: 'separator', raw: char });
      index += 1;
      continue;
    }
    if (char === '<') {
      const consumed = readShellWord(command, index + 1);
      index = Math.max(index + 1, consumed.end);
      continue;
    }
    if (char === '>' || char === '&') {
      if (char === '&') index += 1; // `&>` 的 `&`
      while (command[index + 1] === '>') index += 1;
      // `2>&1` / `>&2` / `2>&-` 是 fd 复制，不写文件；bash 只在 `>&` 后的词
      // 整体是数字或单个 `-` 时才当 fd 复制，`&>file` / `>&12abc` 仍是写目标。
      const duplicatesFileDescriptor = command[index + 1] === '&';
      const target = readShellWord(command, index + (duplicatesFileDescriptor ? 2 : 1));
      index = Math.max(index + 1, target.end);
      if (duplicatesFileDescriptor && /^(?:\d+|-)$/.test(target.raw)) continue;
      tokens.push({ kind: 'redirect', raw: target.raw });
      continue;
    }
    const word = readShellWord(command, index);
    if (word.end <= index) {
      index += 1;
      continue;
    }
    index = word.end;
    // `2>&1` / `1>file` 里紧贴重定向符的 fd 前缀是重定向语法，不是操作数。
    // 留在词里会让 cp / mv 的「最后一个操作数」取到那个数字，真正的写目标反而漏掉
    // （ai-review PR #1650 第 2 轮①）。判据同 bash：数字与 `>`/`<` 之间不能有空格，
    // `cp a b 2 > x` 里的 `2` 仍是操作数。
    if (/^\d+$/.test(word.raw) && (command[index] === '>' || command[index] === '<')) continue;
    if (word.raw) tokens.push({ kind: 'word', raw: word.raw });
  }
  return tokens;
}

/** 写目标在参数位上的命令：cp / mv 写最后一个参数，tee 写每一个文件参数。 */
const ARGUMENT_WRITE_COMMANDS: Record<string, 'last' | 'all'> = { cp: 'last', mv: 'last', tee: 'all' };

function argumentWriteTargets(words: string[]): string[] {
  if (words.length < 2) return [];
  // 命令名也要词法值化：保引号分词后 `c"p"`/`c\p` 这类合法写法带着引号/转义进来，
  // 不词法值化认不出 cp ⇒ 写目标丢失，削弱既有 WRITE_OWNERSHIP_CONFLICT
  // （PR #1709 复审②）。shellWordValue 解完就是 cp。
  const rule = ARGUMENT_WRITE_COMMANDS[path.basename(shellWordValue(words[0]))];
  if (!rule) return [];
  // `-r` / `-a` / `--append` 一律是开关不是路径；`--` 之后才是纯路径，但这里不需要区分。
  // 选项判定要先词法值化（PR #1709 复审③：带引号的 `"-f"` 不过滤会混进操作数遮蔽真目标），
  // 但返回的必须是**原始词**——值化只许在 shellWriteTargets 出口做一遍，做两遍会把
  // 合法路径里的字面反斜杠吃掉（`'/tmp/a\b.txt'` → `/tmp/ab.txt`，复审④②）。
  const operands = words.slice(1).filter((word) => !shellWordValue(word).startsWith('-'));
  if (rule === 'all') return operands;
  return operands.length >= 2 ? [operands[operands.length - 1]] : [];
}

/** 内嵌脚本宿主：`bash`/`sh`/`zsh`/`dash` 的 `-c` 后面第一个词是脚本。 */
const NESTED_SCRIPT_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

/** `bash -c '...'` 内嵌脚本的写目标（原始词，值化在出口统一做）。 */
function nestedScriptTargets(words: string[]): string[] {
  if (words.length < 2) return []; // eval 只要两个词（eval + 脚本）；shell 的 -c 循环自带界
  // PR #1709 复审⑤（二裁维持）：保引号分词后整段脚本是一个引号词，基线靠 canonicalize
  // 拍平顺带抓到，换成保真词法后必须主动找——而且不能只看 words[0]：`env bash -c`、
  // `sudo bash -c`、`timeout 5 bash -c`、`env FOO=1 bash -c` 这些包装前缀会把 shell 挪到
  // 后面的词位。改为在前几个词里扫第一个 shell 名（剥壳），再从它后面找 -c（含 -lc 组合）。
  // 代价：`grep bash -c '…'` 这类「bash 是数据不是命令」的形状会保守多判——方向与 heredoc
  // 同款（多判漏判不对称，选保守），且脚本解析不出写目标时本来就零产出。
  const scanLimit = Math.min(words.length - 2, 6);
  for (let shellIndex = 0; shellIndex <= scanLimit; shellIndex += 1) {
    const wordValue = path.basename(shellWordValue(words[shellIndex]));
    // eval 是内建不是外部命令（PR #1709 复审⑥）：语义 = 剩余参数空格拼接后执行，
    // `eval 'echo x > /etc/z'` 整段字面脚本不递归就零目标，ownership 检查被绕过。
    // 这是「字面脚本在参数里」家族的最后一种形状：外部包装器由上面的剥壳扫描覆盖，
    // 脚本走变量的命中 $ 进 uncertain，source <(…)/ssh 远程执行超出本族。
    if (wordValue === 'eval') {
      return collectShellTargets(words.slice(shellIndex + 1).map(shellWordValue).join(' '));
    }
    if (!NESTED_SCRIPT_SHELLS.has(wordValue)) continue;
    for (let flagIndex = shellIndex + 1; flagIndex < words.length - 1; flagIndex += 1) {
      const flag = shellWordValue(words[flagIndex]);
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag)) {
        // 脚本词先值化成脚本文本（这是词→文本的必要一步），递归产物仍是原始词，不多解。
        return collectShellTargets(shellWordValue(words[flagIndex + 1]));
      }
    }
    return [];
  }
  return [];
}

/** 收集写目标原始词（引号/转义还在词上）；词法值化只在 shellWriteTargets 出口做一遍。 */
function collectShellTargets(command: string): string[] {
  const tokens = tokenizeShellCommand(command);
  const targets: string[] = [];
  let words: string[] = [];
  const flushSegment = (): void => {
    targets.push(...argumentWriteTargets(words));
    targets.push(...nestedScriptTargets(words));
    words = [];
  };
  for (const token of tokens) {
    if (token.kind === 'separator') flushSegment();
    else if (token.kind === 'word') words.push(token.raw);
    else targets.push(token.raw);
  }
  flushSegment();
  return targets;
}

/**
 * shell 命令里的写目标：`>` / `>>` 重定向 + cp / mv / tee 的目标位（fd 复制不算）
 * + `bash -c` 一类内嵌脚本（递归一层，复审④①）。
 * 上线后评测的越权写信号也用它，别再造一份。
 * ponytail: 只认这三个命令名，不做「哪些命令会写盘」的全量枚举——
 * 按名字枚举永远漏，真正的兜底是沙盒本身，这里只补最常见的三条。
 */
export function shellWriteTargets(command: string): string[] {
  return collectShellTargets(command).map(shellWordValue);
}

/**
 * 没被反斜杠转义的换行 → `;`。词中续行（`\` + 换行）由调用方先折掉（descriptorAssessment
 * 里 continuationsFolded 那步），别走到这里。
 * ponytail: 单引号里跨行的字面量也会被换成 `;`，代价是多出一个不成命令的片段
 * （几乎不可能以 cp/mv/tee 开头），方向保守，不为它写引号状态机。
 */
function splitUnescapedNewlines(command: string): string {
  return command.replace(/(?<!\\)\r?\n/g, ' ; ');
}

function genericPathAssessment(
  value: unknown,
  workingDirectory: string,
  key?: string,
): ToolWriteTargets {
  if (typeof value === 'string') {
    if (!key || !isPathLikeParameter(key)) return { targets: [], uncertain: [], mutations: {} };
    if (value.trim() === '') return { targets: [], uncertain: [`uncertain:${key}`], mutations: {} };
    return { targets: [resolveToolPath(value, workingDirectory)], uncertain: [], mutations: {} };
  }
  if (Array.isArray(value)) {
    return mergeAssessments(value.map((entry) => genericPathAssessment(entry, workingDirectory, key)));
  }
  if (!value || typeof value !== 'object') return { targets: [], uncertain: [], mutations: {} };
  return mergeAssessments(Object.entries(value as Record<string, unknown>).map(
    ([childKey, childValue]) => genericPathAssessment(childValue, workingDirectory, childKey),
  ));
}

function descriptorAssessment(
  descriptor: ToolPathAuthorityDescriptor,
  input: ResolveToolWriteTargetsInput,
): ToolWriteTargets {
  if (descriptor.kind === 'path') {
    if (
      descriptor.whenParameter
      && descriptor.whenValues
      && !descriptor.whenValues.includes(String(input.params[descriptor.whenParameter]))
    ) {
      return { targets: [], uncertain: [], mutations: {} };
    }
    const rawPath = input.params[descriptor.pathParameter];
    if (rawPath === undefined) return { targets: [], uncertain: [], mutations: {} };
    const declaredValues: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === 'string') {
        if (value.trim() !== '') declaredValues.push(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (value && typeof value === 'object') {
        Object.values(value as Record<string, unknown>).forEach(collect);
      }
    };
    collect(rawPath);
    if (declaredValues.length === 0) {
      return { targets: [], uncertain: [`uncertain:${descriptor.pathParameter}`], mutations: {} };
    }
    const targets = declaredValues.map((value) => resolveToolPath(value, input.workingDirectory));
    const declaredMutation = descriptor.mutation;
    return {
      targets,
      uncertain: [],
      mutations: declaredMutation
        ? Object.fromEntries(targets.map((target) => [target, declaredMutation]))
        : {},
    };
  }

  const memoryDir = resolveCanonicalRunPath(getMemoryDir());
  if (descriptor.kind === 'global-memory') {
    const scope = typeof input.params.scope === 'string' ? input.params.scope : undefined;
    if (scope === 'role' || scope === 'project' || (!scope && input.agentRole)) {
      return { targets: [], uncertain: [], mutations: {} };
    }
    const rawPath = input.params[descriptor.pathParameter];
    return typeof rawPath === 'string' && rawPath.trim() !== ''
      ? { targets: [resolveCanonicalRunPath(path.join(memoryDir, path.basename(rawPath)))], uncertain: [], mutations: {} }
      : { targets: [], uncertain: [`uncertain:${descriptor.pathParameter}`], mutations: {} };
  }

  const command = input.params[descriptor.commandParameter];
  if (typeof command !== 'string' || command.trim() === '') {
    return { targets: [], uncertain: [`uncertain:${descriptor.commandParameter}`], mutations: {} };
  }
  const targets: string[] = [];
  const uncertain: string[] = [];
  const memoryAlias = path.join(path.basename(path.dirname(memoryDir)), path.basename(memoryDir));
  const canonical = canonicalizeCommand(command);
  // 🔴 重定向目标的分词别喂 canonicalizeCommand 的输出（PR #1709 复审①实测双向错）：
  // 它去引号（安全匹配面要的形状，十几个消费方靠它，不能动），于是
  // `echo x > "/tmp/eval-sandbox escape.txt"` 被截成 /tmp/eval-sandbox——界外写被当界内放行；
  // `printf '%s\n' '>/outside/file'` 的字符串字面量反向被误判成写目标。
  // 分词器本身引号/转义感知（readShellWord/tokenizeShellCommand），只需替 canonicalize
  // 做掉它原来顺带做的两件词法预处理：先折词中续行（`\`+换行，照它的折法消掉），
  // 再把没被反斜杠转义的换行切成 `;`（多行脚本第 2 行起不粘第 1 行，PR #1650 第 3 轮）。
  const continuationsFolded = command.replace(/\\(?:\r\n?|\n)/g, '');
  const redirectTargets = shellWriteTargets(splitUnescapedNewlines(continuationsFolded));
  if (canonical.parsingFailed && redirectTargets.length > 0) {
    uncertain.push(`uncertain-command-analysis:${canonical.failureReason ?? 'parse-failure'}`);
  }
  if (canonical.command.includes(memoryDir) || canonical.command.includes(memoryAlias)) targets.push(memoryDir);
  for (const rawTarget of redirectTargets) {
    const target = rawTarget;
    if (!target || /[$`*?{}]/.test(target)) {
      uncertain.push(`uncertain-redirection:${rawTarget || '<missing>'}`);
    } else {
      targets.push(resolveToolPath(target, input.workingDirectory));
    }
  }
  return { targets, uncertain, mutations: {} };
}

function mergeAssessments(assessments: ToolWriteTargets[]): ToolWriteTargets {
  return {
    targets: assessments.flatMap((assessment) => assessment.targets),
    uncertain: assessments.flatMap((assessment) => assessment.uncertain),
    mutations: assessments.reduce<ToolWriteTargets['mutations']>(
      (merged, assessment) => Object.assign(merged, assessment.mutations),
      {},
    ),
  };
}

/** Resolve write-shaped tool parameters without enumerating tool names. */
export function resolveToolWriteTargets(input: ResolveToolWriteTargetsInput): ToolWriteTargets {
  // generic 扫描对声明过的参数照扫不让位：directive-memory 权威靠它兜底（非 read 一律扫，
  // 条件声明不命中的只读 action 也要被看见）；声明只负责叠加 mutation 档，不收窄目标集合。
  // 代价=多动作工具的只读 action 会被保守拿锁（无覆盖门），已记入证据档盲区。
  const assessment = mergeAssessments([
    ...(input.definition.permissionLevel !== 'read'
      ? [genericPathAssessment(input.params, input.workingDirectory)]
      : []),
    ...(input.definition.pathAuthority ?? []).map((descriptor) => descriptorAssessment(descriptor, input)),
  ]);
  return {
    targets: [...new Set(assessment.targets)].sort(),
    uncertain: [...new Set(assessment.uncertain)].sort(),
    mutations: assessment.mutations,
  };
}

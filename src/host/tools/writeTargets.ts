import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ToolDefinition,
  ToolPathAuthorityDescriptor,
  ToolPathMutationKind,
} from '../../shared/contract';
import { getMemoryDir } from '../lightMemory/indexLoader';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { canonicalizeCommand } from '../security/canonicalizeCommand';

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

/** 去掉整词两端的同类引号：`cp a "/etc/x"` 的目标是 /etc/x，不是带引号的字面量。 */
function unquote(word: string): string {
  const first = word[0];
  if ((first === "'" || first === '"') && word.length >= 2 && word.at(-1) === first) {
    return word.slice(1, -1);
  }
  return word;
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
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === ';' || char === '\n') {
      tokens.push({ kind: 'separator', raw: char });
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
  const rule = ARGUMENT_WRITE_COMMANDS[path.basename(unquote(words[0]))];
  if (!rule) return [];
  // `-r` / `-a` / `--append` 一律是开关不是路径；`--` 之后才是纯路径，但这里不需要区分。
  const operands = words.slice(1).filter((word) => !word.startsWith('-'));
  if (rule === 'all') return operands;
  return operands.length >= 2 ? [operands[operands.length - 1]] : [];
}

/**
 * shell 命令里的写目标：`>` / `>>` 重定向 + cp / mv / tee 的目标位（fd 复制不算）。
 * 上线后评测的越权写信号也用它，别再造一份。
 * ponytail: 只认这三个命令名，不做「哪些命令会写盘」的全量枚举——
 * 按名字枚举永远漏，真正的兜底是沙盒本身，这里只补最常见的三条。
 */
export function shellWriteTargets(command: string): string[] {
  const tokens = tokenizeShellCommand(command);
  const targets: string[] = [];
  let words: string[] = [];
  const flushSegment = (): void => {
    targets.push(...argumentWriteTargets(words));
    words = [];
  };
  for (const token of tokens) {
    if (token.kind === 'separator') flushSegment();
    else if (token.kind === 'word') words.push(token.raw);
    else targets.push(token.raw);
  }
  flushSegment();
  return targets.map(unquote);
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
  const redirectTargets = shellWriteTargets(canonical.command);
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

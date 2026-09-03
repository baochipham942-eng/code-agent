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
    if (/\s/.test(char) || char === ';' || char === '|' || char === '&' || char === '>') break;
  }
  return { raw: command.slice(wordStart, index), end: index };
}

interface ShellRedirectScan {
  targets: string[];
  uncertain: string[];
}

const SHELL_COMMAND_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash']);
const MAX_REDIRECT_WRAPPER_DEPTH = 3;
const SHELL_PARAMETER_EXPANSION = /\$(?:\{|[A-Za-z_]|[0-9@*#?$!-])/;
const SHELL_ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_OPTIONS_WITHOUT_VALUES = new Set(['-i', '--ignore-environment', '-0', '--null', '-v', '--debug']);
const ENV_OPTIONS_WITH_VALUES = new Set(['-u', '--unset', '-C', '--chdir', '--argv0', '-P']);

function shellExecutableName(word: string | undefined): string {
  return path.basename(canonicalizeCommand(word ?? '').command);
}

interface ShellWrapperLookup {
  index: number;
  scriptWords?: string[];
  uncertain?: boolean;
}

function findShellWrapper(words: string[]): ShellWrapperLookup | undefined {
  let index = 0;
  while (index < words.length) {
    while (
      index < words.length
      && SHELL_ASSIGNMENT_PREFIX.test(canonicalizeCommand(words[index]).command)
    ) index += 1;
    const executable = shellExecutableName(words[index]);
    if (SHELL_COMMAND_WRAPPERS.has(executable) || executable === 'eval') return { index };
    if (executable === 'env') {
      const envIndex = index;
      index += 1;
      while (index < words.length) {
        const rawOption = words[index];
        const option = canonicalizeCommand(rawOption).command;
        if (option === '-S' || option === '--split-string') {
          const scriptIndex = index + 1;
          return {
            index: envIndex,
            scriptWords: scriptIndex < words.length ? words.slice(scriptIndex) : [],
            uncertain: scriptIndex >= words.length,
          };
        }
        const inlineSplit = rawOption.startsWith('--split-string=')
          ? rawOption.slice('--split-string='.length)
          : rawOption.startsWith('-S') && rawOption.length > 2
            ? rawOption.slice(2)
            : undefined;
        if (inlineSplit !== undefined) {
          return {
            index: envIndex,
            scriptWords: [inlineSplit, ...words.slice(index + 1)],
            uncertain: inlineSplit === '',
          };
        }
        if (option === '--' || ENV_OPTIONS_WITHOUT_VALUES.has(option)) {
          index += 1;
          continue;
        }
        if (ENV_OPTIONS_WITH_VALUES.has(option)) {
          index += 2;
          continue;
        }
        if (/^(?:--unset|--chdir|--argv0)=/.test(option) || /^-[uCP].+/.test(option)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (executable === 'command') {
      index += 1;
      while (['-p', '--'].includes(canonicalizeCommand(words[index] ?? '').command)) index += 1;
      continue;
    }
    if (executable === 'nohup') {
      index += 1;
      while (canonicalizeCommand(words[index] ?? '').command.startsWith('-')) index += 1;
      continue;
    }
    if (executable === 'timeout') {
      index += 1;
      while (canonicalizeCommand(words[index] ?? '').command.startsWith('-')) index += 1;
      if (index < words.length) index += 1;
      continue;
    }
    if (executable === 'nice') {
      index += 1;
      while (
        canonicalizeCommand(words[index] ?? '').command.startsWith('-')
        || /^[+-]?\d+$/.test(canonicalizeCommand(words[index] ?? '').command)
      ) index += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function findShellScriptIndex(
  words: string[],
  wrapperIndex: number,
): { index?: number; uncertain: boolean } {
  let index = wrapperIndex + 1;
  let uncertain = false;
  while (index < words.length) {
    const option = canonicalizeCommand(words[index]).command;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(option)) {
      let scriptIndex = index + 1;
      if (canonicalizeCommand(words[scriptIndex] ?? '').command === '--') scriptIndex += 1;
      return scriptIndex < words.length
        ? { index: scriptIndex, uncertain }
        : { uncertain: true };
    }
    if (option.startsWith('-') || option.startsWith('+')) {
      index += 1;
      continue;
    }
    uncertain = true;
    index += 1;
  }
  return { uncertain: true };
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let segmentStart = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
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
    const separatesInBackground = char === '&'
      && command[index - 1] !== '>'
      && command[index + 1] !== '>';
    if (char !== ';' && char !== '|' && char !== '\n' && !separatesInBackground) continue;
    segments.push(command.slice(segmentStart, index));
    if (command[index + 1] === char) index += 1;
    segmentStart = index + 1;
  }
  segments.push(command.slice(segmentStart));
  return segments;
}

function readShellWords(command: string): string[] {
  const words: string[] = [];
  let index = 0;
  let previousWordEnd = -1;
  while (index < command.length) {
    while (index < command.length && /\s/.test(command[index])) index += 1;
    const redirectsOutput = command[index] === '>'
      || (command[index] === '&' && command[index + 1] === '>');
    if (redirectsOutput) {
      if (
        command[index] === '>'
        && previousWordEnd === index
        && /^\d+$/.test(words.at(-1) ?? '')
      ) words.pop();
      if (command[index] === '&') index += 1;
      while (command[index + 1] === '>') index += 1;
      const duplicatesFileDescriptor = command[index + 1] === '&';
      const target = readShellWord(command, index + (duplicatesFileDescriptor ? 2 : 1));
      index = Math.max(index + 1, target.end);
      continue;
    }
    const word = readShellWord(command, index);
    if (word.raw !== '') {
      words.push(word.raw);
      previousWordEnd = word.end;
    }
    index = word.end > index ? word.end : index + 1;
  }
  return words;
}

function shellRedirectTargets(command: string, depth = 0): ShellRedirectScan {
  const targets: string[] = [];
  const uncertain: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
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
    if (char !== '>') continue;
    while (command[index + 1] === '>') index += 1;

    const duplicatesFileDescriptor = command[index + 1] === '&';
    const target = readShellWord(command, index + (duplicatesFileDescriptor ? 2 : 1));
    const normalizedTarget = canonicalizeCommand(target.raw).command;
    if (duplicatesFileDescriptor && (normalizedTarget === '' || /^(?:\d+|-)$/.test(normalizedTarget))) {
      index = Math.max(index, target.end - 1);
      continue;
    }
    if (!(command[index - 1] === '&' && normalizedTarget === '')) {
      targets.push(normalizedTarget);
    }
    index = Math.max(index, target.end - 1);
  }

  for (const segment of splitShellSegments(command)) {
    const words = readShellWords(segment);
    const lookup = findShellWrapper(words);
    if (!lookup) continue;
    const wrapperIndex = lookup.index;
    const wrapper = shellExecutableName(words[wrapperIndex]);
    const isShellWrapper = SHELL_COMMAND_WRAPPERS.has(wrapper);
    const isEvalWrapper = wrapper === 'eval';
    const isEnvSplitWrapper = wrapper === 'env' && lookup.scriptWords !== undefined;
    if (!isShellWrapper && !isEvalWrapper && !isEnvSplitWrapper) continue;

    let scriptWords: string[];
    if (isEnvSplitWrapper) {
      if (lookup.uncertain) uncertain.push('uncertain-redirection:env');
      scriptWords = lookup.scriptWords ?? [];
    } else if (isShellWrapper) {
      const script = findShellScriptIndex(words, wrapperIndex);
      if (script.uncertain) {
        uncertain.push(`uncertain-redirection:${wrapper}`);
      }
      if (script.index === undefined) continue;
      scriptWords = words.slice(script.index, script.index + 1);
    } else {
      scriptWords = words.slice(wrapperIndex + 1);
    }
    if (scriptWords.length === 0) continue;
    if (depth >= MAX_REDIRECT_WRAPPER_DEPTH) {
      uncertain.push(`uncertain-redirection:${wrapper}`);
      continue;
    }
    const decodedWords = scriptWords.map((word) => canonicalizeCommand(word));
    const decodedScript = decodedWords.map((word) => word.command).join(' ');
    const decodedAssessment = canonicalizeCommand(decodedScript);
    if (
      scriptWords.some((word) => word.includes('$(') || word.includes('`'))
      || scriptWords.some((word) => SHELL_PARAMETER_EXPANSION.test(word))
      || decodedWords.some((word) => word.parsingFailed)
      || decodedAssessment.parsingFailed
    ) {
      uncertain.push(`uncertain-redirection:${wrapper}`);
      continue;
    }
    const nested = shellRedirectTargets(decodedScript, depth + 1);
    targets.push(...nested.targets);
    uncertain.push(...nested.uncertain);
  }

  return { targets, uncertain };
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
  const redirectScan = shellRedirectTargets(command);
  uncertain.push(...redirectScan.uncertain);
  if (canonical.parsingFailed && redirectScan.targets.length > 0) {
    uncertain.push(`uncertain-command-analysis:${canonical.failureReason ?? 'parse-failure'}`);
  }
  if (canonical.command.includes(memoryDir) || canonical.command.includes(memoryAlias)) targets.push(memoryDir);
  for (const rawTarget of redirectScan.targets) {
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

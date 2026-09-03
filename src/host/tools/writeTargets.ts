import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ToolDefinition,
  ToolPathAuthorityDescriptor,
  ToolPathMutationKind,
} from '../../shared/contract';
import { getMemoryDir } from '../lightMemory/indexLoader';
import { resolveCanonicalRunPath } from '../runtime/runContext';
import { canonicalizeCommand, normalizeShellText } from '../security/canonicalizeCommand';

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
const SHELL_COMMAND_STRING_OPTION = /^-[A-Za-z]*c[A-Za-z]*$/;
const SHELL_ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DYNAMIC_COMMAND_WORD = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const SHELL_CWD_MUTATORS = new Set(['cd', 'pushd', 'popd']);
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
  while (index < words.length) {
    const option = canonicalizeCommand(words[index]).command;
    if (SHELL_COMMAND_STRING_OPTION.test(option)) {
      let scriptIndex = index + 1;
      if (canonicalizeCommand(words[scriptIndex] ?? '').command === '--') scriptIndex += 1;
      return scriptIndex < words.length
        ? { index: scriptIndex, uncertain: false }
        : { uncertain: true };
    }
    index += 1;
  }
  return { uncertain: false };
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

function unresolvedIndirectWrapper(words: string[]): string | undefined {
  // Unknown launchers are not enumerable. A shell followed only by options before a -c-shaped
  // option, or any eval word, is enough to fail closed without guessing how the outer command runs it.
  for (let index = 0; index < words.length; index += 1) {
    const executable = shellExecutableName(words[index]);
    if (executable === 'eval') return executable;
    if (!SHELL_COMMAND_WRAPPERS.has(executable)) continue;
    for (let optionIndex = index + 1; optionIndex < words.length; optionIndex += 1) {
      const option = canonicalizeCommand(words[optionIndex]).command;
      if (SHELL_COMMAND_STRING_OPTION.test(option)) return executable;
      if (!option.startsWith('-')) break;
      if (option === '-o') optionIndex += 1;
    }
  }
  return undefined;
}

function hasShellCommandStringOption(words: string[], commandIndex: number): boolean {
  for (let optionIndex = commandIndex + 1; optionIndex < words.length; optionIndex += 1) {
    const option = canonicalizeCommand(words[optionIndex]).command;
    if (SHELL_COMMAND_STRING_OPTION.test(option)) return true;
    if (!option.startsWith('-')) return false;
    if (option === '-o') optionIndex += 1;
  }
  return false;
}

function isDynamicCommandWord(word: string | undefined): boolean {
  const raw = word?.trim() ?? '';
  if (raw.startsWith("'") && raw.endsWith("'")) return false;
  return DYNAMIC_COMMAND_WORD.test(canonicalizeCommand(raw).command);
}

function hasDynamicCommandConstruction(word: string | undefined): boolean {
  const raw = word?.trim() ?? '';
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === '\\') return true;
    if (character === '$') {
      const next = raw[index + 1];
      if (next === '{' || (next === "'" && quote !== '"')) return true;
    }
    if (character === '"') {
      quote = quote === '"' ? undefined : '"';
    } else if (character === "'" && !quote) {
      quote = "'";
    }
  }
  return false;
}

function isUncertainCommandWord(word: string | undefined): boolean {
  return isDynamicCommandWord(word) || hasDynamicCommandConstruction(word);
}

function dynamicExecutionUncertainty(segment: string, words: string[]): string | undefined {
  const firstWord = readShellWord(segment, 0);
  if (
    isUncertainCommandWord(words[0])
    && segment.slice(firstWord.end).trim() !== ''
  ) return 'dynamic-command';

  for (let index = 0; index < words.length; index += 1) {
    const previous = canonicalizeCommand(words[index - 1] ?? '').command;
    if (
      isUncertainCommandWord(words[index])
      && (index === 0 || !previous.startsWith('-'))
      && hasShellCommandStringOption(words, index)
    ) {
      return 'dynamic-command';
    }
  }

  let commandIndex = 0;
  while (
    commandIndex < words.length
    && SHELL_ASSIGNMENT_PREFIX.test(canonicalizeCommand(words[commandIndex]).command)
  ) commandIndex += 1;
  for (let index = commandIndex; index < words.length; index += 1) {
    const executable = shellExecutableName(words[index]);
    if (!SHELL_COMMAND_WRAPPERS.has(executable) && executable !== 'eval') continue;
    if (words.slice(index + 1).some((word) => /^<<-?/.test(word))) return executable;
  }
  return undefined;
}

function segmentChangesWorkingDirectory(words: string[]): boolean {
  let commandIndex = 0;
  while (
    commandIndex < words.length
    && SHELL_ASSIGNMENT_PREFIX.test(canonicalizeCommand(words[commandIndex]).command)
  ) commandIndex += 1;
  return SHELL_CWD_MUTATORS.has(shellExecutableName(words[commandIndex]));
}

function isIndependentOfWorkingDirectory(target: string): boolean {
  return path.isAbsolute(target) || target === '~' || target.startsWith('~/');
}

function commandSubstitutionContent(command: string, start: number): string {
  if (command[start] === '`') {
    let escaped = false;
    for (let index = start + 1; index < command.length; index += 1) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (command[index] === '\\') {
        escaped = true;
        continue;
      }
      if (command[index] === '`') return command.slice(start + 1, index);
    }
    return command.slice(start + 1);
  }

  let depth = 1;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = start + 2; index < command.length; index += 1) {
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
    if (char === '$' && command[index + 1] === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char !== ')') continue;
    depth -= 1;
    if (depth === 0) return command.slice(start + 2, index);
  }
  return command.slice(start + 2);
}

function substitutionNeedsFailClosed(command: string, start: number): boolean {
  const content = commandSubstitutionContent(command, start);
  return content.includes('>') || /\b(?:sh|bash|zsh|dash|eval)\b/.test(content);
}

function shellRedirectTargets(command: string, depth = 0): ShellRedirectScan {
  const rawCommand = command;
  command = normalizeShellText(command);
  const targets: string[] = [];
  const uncertain: string[] = [];
  for (const segment of splitShellSegments(rawCommand)) {
    const rawDynamicUncertainty = dynamicExecutionUncertainty(segment, readShellWords(segment));
    if (rawDynamicUncertainty) uncertain.push(`uncertain-redirection:${rawDynamicUncertainty}`);
  }
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const isCommandSubstitution = char === '`' || (char === '$' && command[index + 1] === '(');
    const isProcessSubstitution = (char === '<' || char === '>') && command[index + 1] === '(';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (
      quote !== "'"
      && isCommandSubstitution
      && substitutionNeedsFailClosed(command, index)
      && !uncertain.includes('uncertain-redirection:command-substitution')
    ) {
      uncertain.push('uncertain-redirection:command-substitution');
    }
    if (
      !quote
      && isProcessSubstitution
      && substitutionNeedsFailClosed(command, index)
      && !uncertain.includes('uncertain-redirection:process-substitution')
    ) {
      uncertain.push('uncertain-redirection:process-substitution');
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== '>' || isProcessSubstitution) continue;
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

  let workingDirectoryMayHaveChanged = false;
  for (const segment of splitShellSegments(command)) {
    const words = readShellWords(segment);
    const changedBeforeSegment = workingDirectoryMayHaveChanged;
    workingDirectoryMayHaveChanged ||= segmentChangesWorkingDirectory(words);
    const dynamicUncertainty = dynamicExecutionUncertainty(segment, words);
    if (
      dynamicUncertainty
      && !uncertain.includes(`uncertain-redirection:${dynamicUncertainty}`)
    ) uncertain.push(`uncertain-redirection:${dynamicUncertainty}`);
    const lookup = findShellWrapper(words);
    if (!lookup) {
      const fallbackWrapper = unresolvedIndirectWrapper(words);
      if (fallbackWrapper) uncertain.push(`uncertain-redirection:${fallbackWrapper}`);
      continue;
    }
    const wrapperIndex = lookup.index;
    const wrapper = shellExecutableName(words[wrapperIndex]);
    const isShellWrapper = SHELL_COMMAND_WRAPPERS.has(wrapper);
    const isEnvSplitWrapper = wrapper === 'env' && lookup.scriptWords !== undefined;

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
    // This second parse only validates the decoded script. Recurse over decodedScript itself so
    // quotes that were literal inside the wrapper word still delimit targets such as "my file.txt".
    const decodedScriptParsingFailed = canonicalizeCommand(decodedScript).parsingFailed;
    if (
      scriptWords.some((word) => word.includes('$(') || word.includes('`'))
      || scriptWords.some((word) => SHELL_PARAMETER_EXPANSION.test(word))
      || decodedWords.some((word) => word.parsingFailed)
      || decodedScriptParsingFailed
    ) {
      uncertain.push(`uncertain-redirection:${wrapper}`);
      continue;
    }
    const nested = shellRedirectTargets(decodedScript, depth + 1);
    if (changedBeforeSegment) {
      const stableTargets = nested.targets.filter(isIndependentOfWorkingDirectory);
      targets.push(...stableTargets);
      if (stableTargets.length !== nested.targets.length) {
        uncertain.push('uncertain-redirection:cwd-changed');
      }
    } else {
      targets.push(...nested.targets);
    }
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

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
    if (/\s/.test(char) || char === ';' || char === '|' || char === '&') break;
  }
  return { raw: command.slice(wordStart, index), end: index };
}

function shellRedirectTargets(command: string): string[] {
  const targets: string[] = [];
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
    if (duplicatesFileDescriptor && (normalizedTarget === '' || /^[0-9-]/.test(normalizedTarget))) {
      index = Math.max(index, target.end - 1);
      continue;
    }
    if (!(command[index - 1] === '&' && normalizedTarget === '')) {
      targets.push(normalizedTarget);
    }
    index = Math.max(index, target.end - 1);
  }
  return targets;
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
  const redirectTargets = shellRedirectTargets(command);
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

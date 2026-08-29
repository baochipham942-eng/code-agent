import fs from 'node:fs';
import path from 'node:path';
import type { PermissionAskResult } from '../../shared/contract/permission';
import { devSlotFromDataDirName } from '../../shared/devSlot';
import { getUserConfigDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';
import type { PermissionRequestData } from '../tools/types';

const logger = createLogger('ScriptedRunPermissionPolicy');

class ScriptedRunPermissionPolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ScriptedRunPermissionPolicyError';
  }
}

type ScriptedEffect = 'allow' | 'deny';

interface ScriptedRule {
  id: string;
  effect: ScriptedEffect;
  tool: string;
  match: {
    kind: 'path' | 'pathPrefix' | 'command' | 'commandPrefix' | 'requestType';
    value: string;
  };
}

interface ScriptedPolicy {
  version: 1;
  rules: ScriptedRule[];
}

const denyScripted = async (): Promise<PermissionAskResult> => ({
  approved: false,
  denialSource: 'scripted',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRule(value: unknown, index: number): ScriptedRule {
  if (!isRecord(value)) throw new Error(`rules[${index}] must be an object`);

  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const tool = typeof value.tool === 'string' ? value.tool.trim() : '';
  const effect = value.effect;
  if (!id) throw new Error(`rules[${index}].id must be a non-empty string`);
  if (!tool || tool.includes('*') || tool.includes('?')) {
    throw new Error(`rules[${index}].tool must be an exact tool name without wildcards`);
  }
  if (effect !== 'allow' && effect !== 'deny') {
    throw new Error(`rules[${index}].effect must be "allow" or "deny"`);
  }
  if (!isRecord(value.match)) throw new Error(`rules[${index}].match must be an object`);
  const match = value.match;

  const matchKeys = ['path', 'pathPrefix', 'command', 'commandPrefix', 'requestType'] as const;
  const configured = matchKeys.filter((key) => match[key] !== undefined);
  if (configured.length !== 1) {
    throw new Error(`rules[${index}].match must declare exactly one path/command/requestType matcher`);
  }
  const kind = configured[0];
  const matchValue = match[kind];
  if (typeof matchValue !== 'string' || matchValue.trim().length === 0) {
    throw new Error(`rules[${index}].match.${kind} must be a non-empty string`);
  }
  if (effect === 'allow' && kind === 'pathPrefix') {
    const normalized = path.resolve(matchValue);
    if (normalized === path.parse(normalized).root || matchValue === '.' || matchValue === '..') {
      throw new Error(`rules[${index}] may not allow every path`);
    }
  }

  return { id, effect, tool, match: { kind, value: matchValue } };
}

function parsePolicy(raw: string): ScriptedPolicy {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('policy must be an object');
  if (value.version !== 1) throw new Error('policy.version must be 1');
  if (!Array.isArray(value.rules)) throw new Error('policy.rules must be an array');
  return { version: 1, rules: value.rules.map(parseRule) };
}

function requestTarget(
  request: PermissionRequestData,
  kind: ScriptedRule['match']['kind'],
): string | undefined {
  if (kind === 'command' || kind === 'commandPrefix') {
    return typeof request.details.command === 'string' ? request.details.command : undefined;
  }
  if (kind === 'requestType') return request.type;
  const candidate = request.details.path ?? request.details.filePath ?? request.details.file_path;
  return typeof candidate === 'string' ? candidate : undefined;
}

function ruleMatches(rule: ScriptedRule, request: PermissionRequestData): boolean {
  if (rule.tool !== request.tool) return false;
  const target = requestTarget(request, rule.match.kind);
  if (target === undefined) return false;
  return rule.match.kind === 'path' || rule.match.kind === 'command' || rule.match.kind === 'requestType'
    ? target === rule.match.value
    : target.startsWith(rule.match.value);
}

function createHandler(
  policy: ScriptedPolicy,
): (request: PermissionRequestData) => Promise<PermissionAskResult> {
  return async (request) => {
    const matchingRules = policy.rules.filter((rule) => ruleMatches(rule, request));
    if (matchingRules.some((rule) => rule.effect === 'deny')) return denyScripted();
    if (matchingRules.some((rule) => rule.effect === 'allow')) {
      return { approved: true, approvalSource: 'scripted' };
    }
    return denyScripted();
  };
}

/** Eval-only, dev-slot-only permission policy. Missing coverage always denies. */
export function getScriptedRunPermissionHandler():
  | ((request: PermissionRequestData) => Promise<PermissionAskResult>)
  | undefined {
  const policyPath = process.env.NEO_SCRIPTED_APPROVAL_POLICY?.trim();
  if (!policyPath) return undefined;

  const dataDir = getUserConfigDir();
  if (
    process.env.CODE_AGENT_EVAL_BRIDGE !== '1'
    && devSlotFromDataDirName(path.basename(dataDir)) === null
  ) {
    logger.warn('Ignoring NEO_SCRIPTED_APPROVAL_POLICY outside a dev data slot', {
      dataDir,
      policyPath,
    });
    return undefined;
  }

  logger.warn('scripted approval policy ACTIVE (eval mode)', { dataDir, policyPath });
  try {
    return createHandler(parsePolicy(fs.readFileSync(policyPath, 'utf8')));
  } catch (error) {
    logger.warn('Failed to load scripted approval policy; installing deny-all handler', {
      policyPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return denyScripted;
  }
}

/** Real eval entrypoint: a missing or invalid policy is a configuration error, never auto-approval. */
export function requireScriptedRunPermissionHandler(): (
  request: PermissionRequestData,
) => Promise<PermissionAskResult> {
  const policyPath = process.env.NEO_SCRIPTED_APPROVAL_POLICY?.trim();
  if (!policyPath) {
    throw new ScriptedRunPermissionPolicyError('真实评测缺少审批策略，已拒绝运行。');
  }
  try {
    return createHandler(parsePolicy(fs.readFileSync(policyPath, 'utf8')));
  } catch (error) {
    throw new ScriptedRunPermissionPolicyError(
      `真实评测的审批策略无法读取，已拒绝运行：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

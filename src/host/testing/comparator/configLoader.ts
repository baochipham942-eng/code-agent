// Config Loader - Load CompareConfiguration from YAML files
import fs from 'fs/promises';
import * as yaml from 'js-yaml';
import type { CompareConfiguration } from '../types';
import { SPAWN_GUARD } from '../../../shared/constants/agent';
import { validateDiscoverableSkills } from '../skillSelection';

function optionalString(value: unknown, field: string, filePath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid compare config in ${filePath}: "${field}" must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, filePath: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid compare config in ${filePath}: "${field}" must be a boolean`);
  }
  return value;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  filePath: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(
      `Invalid compare config in ${filePath}: "${field}" must be one of ${allowed.join(', ')}`,
    );
  }
  return value as T;
}

function optionalSpawnDepth(value: unknown, field: string, filePath: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 0
    || value > SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH
  ) {
    throw new Error(
      `Invalid compare config in ${filePath}: "${field}" must be an integer between 0 and ${SPAWN_GUARD.HARD_MAX_SPAWN_DEPTH} (0 = no fan-out)`,
    );
  }
  return value;
}

/**
 * Load a CompareConfiguration from a YAML file.
 */
export async function loadCompareConfig(
  filePath: string,
  options: { workingDirectory?: string; discoverableSkillNames?: readonly string[] } = {},
): Promise<CompareConfiguration> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = yaml.load(content) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid compare config in ${filePath}: expected a YAML object`);
  }

  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Invalid compare config in ${filePath}: missing required field "name"`);
  }

  const parsedHarness = parsed.harness && typeof parsed.harness === 'object'
    ? parsed.harness as Record<string, unknown>
    : undefined;
  if (parsed.harness !== undefined && !parsedHarness) {
    throw new Error(`Invalid compare config in ${filePath}: "harness" must be an object`);
  }
  const parsedMemory = parsed.memory && typeof parsed.memory === 'object'
    ? parsed.memory as Record<string, unknown>
    : undefined;
  if (parsed.memory !== undefined && !parsedMemory) {
    throw new Error(`Invalid compare config in ${filePath}: "memory" must be an object`);
  }
  const parsedOrchestration = parsed.orchestration && typeof parsed.orchestration === 'object'
    ? parsed.orchestration as Record<string, unknown>
    : undefined;
  if (parsed.orchestration !== undefined && !parsedOrchestration) {
    throw new Error(`Invalid compare config in ${filePath}: "orchestration" must be an object`);
  }

  let skills: string[] | undefined;
  if (parsed.skills !== undefined) {
    if (
      !Array.isArray(parsed.skills)
      || parsed.skills.some((item) => typeof item !== 'string' || item.trim() === '')
    ) {
      throw new Error(`Invalid compare config in ${filePath}: "skills" must be an array of strings`);
    }
    skills = await validateDiscoverableSkills(
      parsed.skills as string[],
      options.workingDirectory ?? process.cwd(),
      options.discoverableSkillNames,
    );
  }

  return {
    name: parsed.name as string,
    model: optionalString(parsed.model, 'model', filePath),
    provider: optionalString(parsed.provider, 'provider', filePath),
    systemPrompt: optionalString(parsed.systemPrompt, 'systemPrompt', filePath),
    harness: parsedHarness
      ? {
          name: parsed.name as string,
          contextCompression: optionalBoolean(parsedHarness.contextCompression, 'harness.contextCompression', filePath),
          compressionPipeline: optionalBoolean(parsedHarness.compressionPipeline, 'harness.compressionPipeline', filePath),
          scaffoldProfile: optionalBoolean(parsedHarness.scaffoldProfile, 'harness.scaffoldProfile', filePath),
          thinkingInjection: optionalBoolean(parsedHarness.thinkingInjection, 'harness.thinkingInjection', filePath),
          hooksEnabled: optionalBoolean(parsedHarness.hooksEnabled, 'harness.hooksEnabled', filePath),
          toolMode: optionalEnum(parsedHarness.toolMode, ['all', 'deferred'], 'harness.toolMode', filePath),
        }
      : undefined,
    memory: parsedMemory
      ? {
          longTerm: optionalBoolean(parsedMemory.longTerm, 'memory.longTerm', filePath),
          routingModel: optionalString(parsedMemory.routingModel, 'memory.routingModel', filePath),
        }
      : undefined,
    reasoningEffort: optionalEnum(
      parsed.reasoningEffort,
      ['low', 'medium', 'high', 'xhigh'],
      'reasoningEffort',
      filePath,
    ),
    orchestration: parsedOrchestration
      ? {
          allowSwarm: optionalBoolean(parsedOrchestration.allowSwarm, 'orchestration.allowSwarm', filePath),
          spawnMaxDepth: optionalSpawnDepth(parsedOrchestration.spawnMaxDepth, 'orchestration.spawnMaxDepth', filePath),
        }
      : undefined,
    skills,
    enabledTools: parsed.enabledTools as string[] | undefined,
    temperature: parsed.temperature as number | undefined,
    agentConfig: parsed.agentConfig as Record<string, unknown> | undefined,
  };
}

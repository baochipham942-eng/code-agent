// Config Loader - Load CompareConfiguration from YAML files
import fs from 'fs/promises';
import yaml from 'js-yaml';
import type { CompareConfiguration } from '../types';

/**
 * Load a CompareConfiguration from a YAML file.
 */
export async function loadCompareConfig(filePath: string): Promise<CompareConfiguration> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = yaml.load(content) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid compare config in ${filePath}: expected a YAML object`);
  }

  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Invalid compare config in ${filePath}: missing required field "name"`);
  }

  return {
    name: parsed.name as string,
    model: parsed.model as string | undefined,
    provider: parsed.provider as string | undefined,
    generation: parsed.generation as string | undefined,
    systemPrompt: parsed.systemPrompt as string | undefined,
    enabledTools: parsed.enabledTools as string[] | undefined,
    temperature: parsed.temperature as number | undefined,
    agentConfig: parsed.agentConfig as Record<string, unknown> | undefined,
  };
}

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import policy from '../lib/gates-fast-policy.json';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../..');
export const ratchetScript = path.resolve(repoRoot, 'scripts/perf-journey-ratchet.mjs');

export const JOURNEY_RULE_IDS = [
  'perf-journey-cold-start',
  'perf-journey-first-token',
  'perf-journey-long-session',
  'perf-journey-session-switch',
] as const;

export function shouldRunJourneyProbe(): boolean {
  return Boolean(process.env.GATES_FAST_MANIFEST) || process.env.PERF_JOURNEY_FORCE === '1';
}

export function journeyRule(id: (typeof JOURNEY_RULE_IDS)[number]) {
  const rule = policy.rules.find((entry) => entry.id === id);
  if (!rule) throw new Error(`missing gates-fast rule ${id}`);
  return rule;
}

export function runJourneyRatchet(journey: string, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [ratchetScript, '--journey', journey, ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    timeout: 90_000,
  });
}

// getUserConfigDir() returns CODE_AGENT_DATA_DIR when it is set. tests/globalSetup.ts
// pins that variable, so a test that assigns only a non-empty CODE_AGENT_HOME to move
// user config is a silent no-op. Empty HOME (`''`) clears the override; it is not isolation.
// Assigning DATA_DIR anywhere in the same file (including `''` or a saved-value restore) counts.
//
// Allowlist: these files assign HOME because the code under test reads getHomeDir() /
// canonical home, not getUserConfigDir(). One line each.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const testsRoot = path.join(repoRoot, 'tests');
const HOME_KEY = ['CODE_AGENT', 'HOME'].join('_');
const DATA_KEY = ['CODE_AGENT', 'DATA_DIR'].join('_');

const ALLOWLIST: Record<string, string> = {
  'tests/unit/services/voiceHomeProjectBoundary.test.ts':
    '假 HOME 交给 getHomeDir()，验家目录写边界，不是用户配置目录。',
  'tests/unit/tools/toolExecutor.homeBoundary.test.ts':
    'canonicalHomes 读 getHomeDir()（HOME 优先），假 HOME 是写边界输入。',
  'tests/agent/agentOrchestrator.test.ts':
    '语音后台 run 用 HOME 当 canonical home，验写 home 不得 approve。',
  'tests/unit/services/core/devSlotSeed.test.ts':
    '生产配置目录走 getHomeDir()，DATA_DIR 不参与这条路径。',
};

function listTests(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      listTests(full, acc);
      continue;
    }
    if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) acc.push(full);
  }
}

function assigns(source: string, key: string): boolean {
  const patterns = [
    new RegExp(String.raw`process\.env\.${key}\s*=(?!=)`),
    new RegExp(String.raw`\bstubEnv\(\s*['"]${key}['"]`),
    new RegExp(String.raw`(?:^|[{,])\s*(?:['"]${key}['"]|${key})\s*:`, 'm'),
  ];
  return patterns.some((pattern) => pattern.test(source));
}

function assignsNonEmptyHome(source: string): boolean {
  const emptied = source
    .replace(new RegExp(String.raw`process\.env\.${HOME_KEY}\s*=\s*(?:''|"")\s*;?`, 'g'), '')
    .replace(new RegExp(String.raw`\bstubEnv\(\s*['"]${HOME_KEY}['"]\s*,\s*(?:''|"")\s*\)`, 'g'), '');
  return assigns(emptied, HOME_KEY);
}

function relative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

describe('CODE_AGENT_HOME config isolation guard', () => {
  it('flags tests that assign HOME without also assigning DATA_DIR', () => {
    const files: string[] = [];
    listTests(testsRoot, files);
    const hits = files
      .map(relative)
      .filter((rel) => {
        const source = readFileSync(path.join(repoRoot, rel), 'utf8');
        return assignsNonEmptyHome(source) && !assigns(source, DATA_KEY);
      })
      .sort();

    const allowlisted = Object.keys(ALLOWLIST).sort();
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason, file).toMatch(/^\S.*\S$/);
      expect(reason.includes('\n'), file).toBe(false);
      expect(existsSync(path.join(repoRoot, file)), file).toBe(true);
    }

    const unexpected = hits.filter((file) => !ALLOWLIST[file]);
    const stale = allowlisted.filter((file) => !hits.includes(file));
    expect(
      unexpected,
      `CODE_AGENT_HOME assigned without CODE_AGENT_DATA_DIR:\n${unexpected.join('\n')}`,
    ).toEqual([]);
    expect(stale, `allowlist entry is not a HOME-only assignment:\n${stale.join('\n')}`).toEqual([]);
  });
});

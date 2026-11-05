// Static-contract guard for tests/manual/delegateWorkdirLiveCases.manual.ts.
// The manual script runs main() on import (real GLM call), so it can't be
// imported here. Pin the invariants that keep it safe and honest instead:
// temp-home isolation, nothing real executed, key never printed, real schemas.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../manual/delegateWorkdirLiveCases.manual.ts');
const src = readFileSync(SCRIPT, 'utf8');

describe('delegateWorkdirLiveCases.manual.ts guard', () => {
  it('points HOME / CODE_AGENT_HOME / data dir at a temp dir before importing host modules', () => {
    const home = src.indexOf('process.env.CODE_AGENT_HOME = tempHome');
    expect(src).toContain('mkdtempSync(path.join(tmpdir(), ');
    expect(src).toContain('process.env.HOME = tempHome');
    expect(src).toContain('process.env.CODE_AGENT_DATA_DIR = dataDir');
    expect(home).toBeGreaterThan(-1);
    const firstHostImport = src.indexOf("await import('../../src/host/config/configPaths')");
    expect(firstHostImport).toBeGreaterThan(home);
    expect(src).toMatch(/finally \{[\s\S]*rmSync\(tempHome, \{ recursive: true, force: true \}\)/);
  });

  it('never spawns anything real: only `ls` and the restart probe via npx tsx', () => {
    expect(src).not.toMatch(/(?<![.\w])exec(Sync)?\(/);
    const execFileCalls = [...src.matchAll(/execFileSync\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(execFileCalls).toEqual(['ls']);
    const spawnCalls = [...src.matchAll(/spawnSync\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(spawnCalls).toEqual(['npx']);
    // osascript only appears as simulated text / model-facing prose, never as a command.
    expect(src).not.toMatch(/(execFileSync|spawnSync)\([^)]*osascript/);
  });

  it('stubs the tool executor so connector/Bash handlers never run', () => {
    expect(src).toContain('harness-ok (stubbed: nothing executed on this machine)');
    expect(src).toContain('toolExecutor: { execute }');
  });

  it('keeps the API key out of logs and scrubs account/home from output', () => {
    const uses = src.split('\n').filter((line) => /\bapiKey\b/.test(line));
    for (const line of uses) {
      expect(line).not.toMatch(/log\(|console\.|writeFileSync/);
    }
    expect(src).toContain('.split(ACCOUNT).join(\'USER\').split(HOME_DIR).join(\'~\')');
    expect(src).toContain('console.error(scrub(message))');
  });

  it('grades with the REAL registered schemas and planner, not hand-built objects', async () => {
    expect(src).toContain("'../../src/host/tools/modules/commandCenter/sessionCommandCenter.schema'");
    expect(src).toContain("'../../src/host/tools/modules/shell/bash.schema'");
    expect(src).toContain("'../../src/host/config/sessionWorkDirectory'");
    const cc = await import('../../../src/host/tools/modules/commandCenter/sessionCommandCenter.schema');
    const bash = await import('../../../src/host/tools/modules/shell/bash.schema');
    const swd = await import('../../../src/host/config/sessionWorkDirectory');
    expect(cc.delegateTaskSchema.name).toBe('delegate_task');
    expect(bash.bashSchema.name).toBe('Bash');
    expect(typeof swd.planSessionWorkDirectory).toBe('function');
  });
});

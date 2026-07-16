import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');

import {
  FolderTrustService,
  resetFolderTrustServiceForTest,
} from '../../../src/host/security/folderTrustService';

async function writeFile(filePath: string, content = '{}'): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

describe('FolderTrustService', () => {
  let tmpRoot: string;
  let dataDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-trust-'));
    dataDir = path.join(tmpRoot, 'data');
    projectDir = path.join(tmpRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    vi.stubEnv('CODE_AGENT_TEST_DEFAULT_FOLDER_TRUST', '');
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    resetFolderTrustServiceForTest();
  });

  afterEach(async () => {
    resetFolderTrustServiceForTest();
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('discovers active project danger surfaces and treats absent trust as untrusted', async () => {
    await writeFile(path.join(projectDir, '.code-agent', 'hooks', 'hooks.json'), '{"PreToolUse":[]}');
    await writeFile(path.join(projectDir, '.code-agent', 'mcp.json'), '{"servers":[]}');
    await writeFile(path.join(projectDir, '.code-agent', 'mcp.local.json'), '{"servers":[]}');
    await writeFile(path.join(projectDir, '.code-agent', 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nBody');
    await writeFile(path.join(projectDir, '.code-agent', 'skills', 'danger', 'SKILL.md'), '---\nname: danger\ndescription: danger\n---\nBody');
    await writeFile(path.join(projectDir, '.code-agent', 'commands', 'ship.md'), 'Ship');
    await writeFile(path.join(projectDir, '.code-agent', 'skill-preferences.json'), '{"version":1,"overrides":{"danger":true}}');
    await writeFile(path.join(projectDir, '.code-agent', 'PROFILE.md'), 'project profile');
    await writeFile(path.join(projectDir, 'AGENTS.md'), '# agent instructions');
    await writeFile(path.join(projectDir, 'code-agent-policy.toml'), '[execution]\nallow_shell = false\n');

    const service = new FolderTrustService();
    const result = await service.evaluate(projectDir);

    expect(result.state).toBe('untrusted');
    expect(result.canonicalRealpath).toBe(await fs.realpath(projectDir));
    expect(result.dangerousItems.map((item) => item.kind).sort()).toEqual([
      'agent-instructions',
      'project-agents',
      'project-commands',
      'project-hooks',
      'project-mcp',
      'project-policy',
      'project-profile',
      'project-skill-preferences',
      'project-skills',
      'project-mcp-local',
    ].sort());
    expect(result.blockedItems.map((item) => item.kind).sort()).toEqual(
      result.dangerousItems.map((item) => item.kind).sort(),
    );
  });

  it('keys trust by canonical realpath so symlinks cannot bypass a decision', async () => {
    await writeFile(path.join(projectDir, '.code-agent', 'hooks', 'hooks.json'), '{"PreToolUse":[]}');
    const linkPath = path.join(tmpRoot, 'project-link');
    await fs.symlink(projectDir, linkPath);

    const service = new FolderTrustService();
    await service.set(projectDir, 'trusted', 'test');

    const viaLink = await service.evaluate(linkPath);
    expect(viaLink.state).toBe('trusted');
    expect(viaLink.canonicalRealpath).toBe(await fs.realpath(projectDir));

    await service.set(linkPath, 'blocked', 'test');
    const viaRealPath = await service.evaluate(projectDir);
    expect(viaRealPath.state).toBe('blocked');
  });

  it('does not silently inherit trust when a trusted path is deleted and recreated', async () => {
    await writeFile(path.join(projectDir, '.code-agent', 'hooks', 'hooks.json'), '{"PreToolUse":[]}');
    const service = new FolderTrustService();
    await service.set(projectDir, 'trusted', 'test');
    expect((await service.evaluate(projectDir)).state).toBe('trusted');

    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, '.code-agent', 'hooks', 'hooks.json'), '{"PreToolUse":[]}');

    const result = await service.evaluate(projectDir);
    expect(result.state).toBe('untrusted');
    expect(result.identityChanged).toBe(true);
    expect(result.blockedItems.map((item) => item.kind)).toContain('project-hooks');
  });
});

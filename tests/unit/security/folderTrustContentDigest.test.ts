import { createHash } from 'node:crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');

import Database from 'better-sqlite3';
import {
  FolderTrustService,
  type DangerousConfigItem,
} from '../../../src/host/security/folderTrustService';
import { configureFolderTrustService } from '../../../src/host/security/folderTrustServiceConfig';
import { getUserConfigDir } from '../../../src/host/config/configPaths';

const ENV_SENTINEL = 'digest-env-sentinel';

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readGatedDigest(realpath: string): string | null {
  const db = new Database(path.join(getUserConfigDir(), 'code-agent.db'));
  try {
    const row = db.prepare(
      'SELECT gated_digest FROM folder_trust WHERE canonical_realpath = ?',
    ).get(realpath) as { gated_digest: string | null } | undefined;
    return row?.gated_digest ?? null;
  } finally {
    db.close();
  }
}

function writeGatedDigest(realpath: string, digest: string): void {
  const db = new Database(path.join(getUserConfigDir(), 'code-agent.db'));
  try {
    db.prepare('UPDATE folder_trust SET gated_digest = ? WHERE canonical_realpath = ?')
      .run(digest, realpath);
  } finally {
    db.close();
  }
}

function snapshotEntries(stored: string): string[] {
  const parsed = JSON.parse(stored) as unknown;
  if (!Array.isArray(parsed)) throw new Error('gated_digest is not an array');
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function toTwoPartSnapshot(stored: string): string {
  return JSON.stringify(snapshotEntries(stored).map((entry) => {
    const parts = entry.split('\0');
    return parts.length >= 2 ? `${parts[0]}\0${parts[1]}` : entry;
  }));
}

function itemDigest(items: DangerousConfigItem[], kind: string, pathSuffix: string): string | undefined {
  return items.find((item) => item.kind === kind && item.path.endsWith(pathSuffix))?.contentDigest;
}

describe('folder trust content digests', () => {
  let tmpRoot: string;
  let dataDir: string;
  let projectDir: string;
  let service: FolderTrustService;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-trust-digest-'));
    dataDir = path.join(tmpRoot, 'data');
    projectDir = path.join(tmpRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    configureFolderTrustService({});
    service = new FolderTrustService();
  });

  afterEach(async () => {
    service.close();
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('change hook command re-asks', async () => {
    const hooksPath = path.join(projectDir, '.code-agent', 'hooks', 'hooks.json');
    await writeFile(hooksPath, JSON.stringify({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo one', timeout: 5 }] }],
    }));
    await service.set(projectDir, 'trusted', 'user');

    await writeFile(hooksPath, JSON.stringify({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo two', timeout: 5 }] }],
    }));
    const changed = await service.evaluate(projectDir);
    expect(changed.contentChanged).toBe(true);
    expect(changed.state).toBe('untrusted');
    expect(changed.identityChanged).toBe(false);
  });

  it('adding a hook entry to a trusted hooks.json re-asks', async () => {
    const hooksPath = path.join(projectDir, '.code-agent', 'hooks', 'hooks.json');
    await writeFile(hooksPath, JSON.stringify({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo one', timeout: 5 }] }],
    }));
    await service.set(projectDir, 'trusted', 'user');

    await writeFile(hooksPath, JSON.stringify({
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'echo one', timeout: 5 },
          { type: 'command', command: 'echo two' },
        ],
      }],
    }));
    const changed = await service.evaluate(projectDir);
    expect(changed.contentChanged).toBe(true);
    expect(changed.state).toBe('untrusted');
  });

  it('reformatting hooks.json or reordering keys keeps the folder trusted', async () => {
    const hooksPath = path.join(projectDir, '.code-agent', 'hooks', 'hooks.json');
    await writeFile(hooksPath, JSON.stringify({
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'echo one', timeout: 5 },
          { type: 'command', command: 'echo two' },
        ],
      }],
    }));
    await service.set(projectDir, 'trusted', 'user');
    const realpath = await fs.realpath(projectDir);
    const stored = readGatedDigest(realpath);
    expect(stored).toBeTruthy();
    const hookEntry = snapshotEntries(stored as string).find((entry) => entry.startsWith('project-hooks\0'));
    expect(hookEntry?.split('\0')).toHaveLength(3);

    await writeFile(hooksPath, `{
      "PreToolUse": [
        {
          "hooks": [
            { "command": "echo two", "type": "command" },
            { "timeout": 5, "command": "echo one", "type": "command" }
          ],
          "matcher": "Bash"
        }
      ]
    }`);
    const after = await service.evaluate(projectDir);
    expect(after.contentChanged).toBe(false);
    expect(after.state).toBe('trusted');
    expect(itemDigest(after.dangerousItems, 'project-hooks', 'hooks.json')).toBe(hookEntry?.split('\0')[2]);
  });

  it('editing only permissions in legacy settings.json keeps the folder trusted', async () => {
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    await writeFile(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'], deny: [] },
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi', timeout: 1 }] }],
      },
    }));
    await service.set(projectDir, 'trusted', 'user');

    await writeFile(settingsPath, `{
      "permissions": { "deny": ["Bash(rm:*)"], "allow": ["Bash(ls:*)", "Bash(pwd:*)"] },
      "hooks": {
        "SessionStart": [
          {
            "hooks": [{ "timeout": 1, "command": "echo hi", "type": "command" }],
            "matcher": "*"
          }
        ]
      }
    }`);
    const still = await service.evaluate(projectDir);
    expect(still.contentChanged).toBe(false);
    expect(still.state).toBe('trusted');

    await writeFile(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo changed', timeout: 1 }] }],
      },
    }));
    const changed = await service.evaluate(projectDir);
    expect(changed.contentChanged).toBe(true);
    expect(changed.state).toBe('untrusted');
  });

  it('a stdio MCP command edit re-asks and an HTTP MCP edit does not', async () => {
    const mcpPath = path.join(projectDir, '.code-agent', 'mcp.json');
    const original = {
      servers: [
        {
          name: 'fs',
          command: 'npx',
          args: ['server'],
          env: { TOKEN: ENV_SENTINEL },
        },
      ],
      mcpServers: {
        remote: { url: 'https://example.com/mcp' },
        local: { command: 'node', args: ['local.js'], env: { TOKEN: ENV_SENTINEL } },
      },
    };
    await writeFile(mcpPath, JSON.stringify(original));
    await service.set(projectDir, 'trusted', 'user');
    const realpath = await fs.realpath(projectDir);
    const stored = readGatedDigest(realpath);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(ENV_SENTINEL);
    const trusted = await service.evaluate(projectDir);
    expect(JSON.stringify(trusted)).not.toContain(ENV_SENTINEL);
    expect(trusted.state).toBe('trusted');

    original.mcpServers.remote.url = 'https://example.com/mcp/v2';
    await writeFile(mcpPath, JSON.stringify(original));
    const httpEdit = await service.evaluate(projectDir);
    expect(httpEdit.contentChanged).toBe(false);
    expect(httpEdit.state).toBe('trusted');

    await writeFile(mcpPath, `{
      "mcpServers": {
        "local": { "env": { "TOKEN": "${ENV_SENTINEL}" }, "args": ["local.js"], "command": "node" },
        "remote": { "url": "https://example.com/mcp/v2" }
      },
      "servers": [
        { "env": { "TOKEN": "${ENV_SENTINEL}" }, "args": ["server"], "command": "npx", "name": "fs" }
      ]
    }`);
    const reformatted = await service.evaluate(projectDir);
    expect(reformatted.contentChanged).toBe(false);
    expect(reformatted.state).toBe('trusted');

    original.servers[0].command = 'node';
    await writeFile(mcpPath, JSON.stringify(original));
    const commandEdit = await service.evaluate(projectDir);
    expect(commandEdit.contentChanged).toBe(true);
    expect(commandEdit.state).toBe('untrusted');

    await service.set(projectDir, 'trusted', 'user');
    original.mcpServers.local.command = 'bun';
    await writeFile(mcpPath, JSON.stringify(original));
    const claudeFormatEdit = await service.evaluate(projectDir);
    expect(claudeFormatEdit.contentChanged).toBe(true);
    expect(claudeFormatEdit.state).toBe('untrusted');

    await service.set(projectDir, 'trusted', 'user');
    original.mcpServers.local.env = { TOKEN: `${ENV_SENTINEL}-rotated` };
    await writeFile(mcpPath, JSON.stringify(original));
    const envEdit = await service.evaluate(projectDir);
    expect(envEdit.contentChanged).toBe(true);
    expect(envEdit.state).toBe('untrusted');
    expect(JSON.stringify(envEdit)).not.toContain(`${ENV_SENTINEL}-rotated`);

    await service.set(projectDir, 'trusted', 'user');
    original.servers[0].args = ['server', '--changed'];
    await writeFile(mcpPath, JSON.stringify(original));
    const argsEdit = await service.evaluate(projectDir);
    expect(argsEdit.contentChanged).toBe(true);
    expect(argsEdit.state).toBe('untrusted');
  });

  it('an old 2-part gated_digest does not retroactively re-ask', async () => {
    const hooksPath = path.join(projectDir, '.code-agent', 'hooks', 'hooks.json');
    const policyPath = path.join(projectDir, 'code-agent-policy.toml');
    await writeFile(hooksPath, JSON.stringify({
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo one' }] }],
    }));
    await writeFile(policyPath, 'allow_shell = false\n');
    await service.set(projectDir, 'trusted', 'user');
    const realpath = await fs.realpath(projectDir);
    const current = readGatedDigest(realpath);
    expect(current).toBeTruthy();
    writeGatedDigest(realpath, toTwoPartSnapshot(current as string));

    await writeFile(hooksPath, JSON.stringify({
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo two' }] }],
    }));
    const grandfathered = await service.evaluate(projectDir);
    expect(grandfathered.contentChanged).toBe(false);
    expect(grandfathered.state).toBe('trusted');

    await service.set(projectDir, 'trusted', 'user');
    const rewritten = readGatedDigest(realpath);
    expect(rewritten).toBeTruthy();
    const entries = snapshotEntries(rewritten as string);
    const hookEntry = entries.find((entry) => entry.startsWith('project-hooks\0'));
    const policyEntry = entries.find((entry) => entry.startsWith('project-policy\0'));
    expect(hookEntry?.split('\0')).toHaveLength(3);
    expect(hookEntry?.split('\0')[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(policyEntry?.split('\0')).toHaveLength(2);

    await writeFile(hooksPath, JSON.stringify({
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo three' }] }],
    }));
    const afterRewrite = await service.evaluate(projectDir);
    expect(afterRewrite.contentChanged).toBe(true);
    expect(afterRewrite.state).toBe('untrusted');
  });

  it('sync and async discovery produce the same content digest', async () => {
    const hooksText = JSON.stringify({
      PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo post' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre', timeout: 9 }] }],
    });
    const settingsText = JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
    });
    const mcpText = JSON.stringify({
      servers: [
        { name: 'remote', serverUrl: 'https://example.com/mcp' },
        { name: 'fs', command: 'npx', args: ['srv'], env: { TOKEN: ENV_SENTINEL } },
      ],
    });
    const localRaw = '{not json';
    await writeFile(path.join(projectDir, '.code-agent', 'hooks', 'hooks.json'), hooksText);
    await writeFile(path.join(projectDir, '.claude', 'settings.json'), settingsText);
    await writeFile(path.join(projectDir, '.code-agent', 'mcp.json'), mcpText);
    await writeFile(path.join(projectDir, '.code-agent', 'mcp.local.json'), localRaw);
    await writeFile(path.join(projectDir, 'code-agent-policy.toml'), 'allow_shell = false\n');

    const asyncItems = (await service.evaluate(projectDir)).dangerousItems;
    service.close();
    const syncService = new FolderTrustService();
    try {
      const syncItems = syncService.evaluateSync(projectDir).dangerousItems;
      const suffixes: Array<[string, string]> = [
        ['project-hooks', 'hooks.json'],
        ['project-hooks', 'settings.json'],
        ['project-mcp', 'mcp.json'],
        ['project-mcp-local', 'mcp.local.json'],
        ['project-policy', 'code-agent-policy.toml'],
      ];
      for (const [kind, suffix] of suffixes) {
        expect(itemDigest(syncItems, kind, suffix)).toBe(itemDigest(asyncItems, kind, suffix));
      }
      expect(itemDigest(syncItems, 'project-hooks', 'hooks.json')).toMatch(/^[0-9a-f]{64}$/);
      expect(itemDigest(syncItems, 'project-hooks', 'settings.json')).toMatch(/^[0-9a-f]{64}$/);
      expect(itemDigest(syncItems, 'project-mcp', 'mcp.json')).toMatch(/^[0-9a-f]{64}$/);
      expect(itemDigest(syncItems, 'project-mcp-local', 'mcp.local.json')).toBe(sha256Hex(localRaw));
      expect(itemDigest(syncItems, 'project-policy', 'code-agent-policy.toml')).toBeUndefined();
    } finally {
      syncService.close();
    }

    service = new FolderTrustService();
    await service.set(projectDir, 'trusted', 'user');
    service.close();
    const afterAsyncSet = new FolderTrustService();
    try {
      const syncView = afterAsyncSet.evaluateSync(projectDir);
      expect(syncView.contentChanged).toBe(false);
      expect(syncView.state).toBe('trusted');
    } finally {
      afterAsyncSet.close();
    }

    const syncWriter = new FolderTrustService();
    syncWriter.setSync(projectDir, 'trusted', 'user');
    syncWriter.close();
    service = new FolderTrustService();
    const asyncView = await service.evaluate(projectDir);
    expect(asyncView.contentChanged).toBe(false);
    expect(asyncView.state).toBe('trusted');
  });

  it('an unparseable hooks file hashes the raw text and any edit re-asks', async () => {
    const hooksPath = path.join(projectDir, '.code-agent', 'hooks', 'hooks.json');
    const raw = '{ this is not json';
    await writeFile(hooksPath, raw);
    const found = await service.evaluate(projectDir);
    expect(itemDigest(found.dangerousItems, 'project-hooks', 'hooks.json')).toBe(sha256Hex(raw));

    await service.set(projectDir, 'trusted', 'user');
    const edited = '{ still not json';
    await writeFile(hooksPath, edited);
    const changed = await service.evaluate(projectDir);
    expect(changed.contentChanged).toBe(true);
    expect(changed.state).toBe('untrusted');
    expect(itemDigest(changed.dangerousItems, 'project-hooks', 'hooks.json')).toBe(sha256Hex(edited));
  });
});

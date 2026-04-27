import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ParsedSkill } from '../../../src/shared/contract/agentSkill';

const mocks = vi.hoisted(() => ({
  stdioTransport: vi.fn(function (this: { options: unknown; close: () => Promise<void> }, options: unknown) {
    this.options = options;
    this.close = () => Promise.resolve();
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mocks.stdioTransport,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../../src/main/services/core/configService', () => ({
  getConfigService: vi.fn(() => ({
    getServiceApiKey: vi.fn(() => ''),
  })),
}));

const { createStdioMCPEnv, createTransport } = await import('../../../src/main/mcp/mcpTransport');
const { getDefaultMCPServers } = await import('../../../src/main/mcp/mcpDefaultServers');
const { checkSkillDependencies, loadSkillReferences } = await import('../../../src/main/services/skills/skillLoader');

function makeSkill(basePath: string, references: string[]): ParsedSkill {
  return {
    name: 'test-skill',
    description: 'test',
    promptContent: '',
    basePath,
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'user',
    references,
  };
}

describe('MCP and skill security boundaries', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tmpDir: string;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    mocks.stdioTransport.mockClear();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-skills-boundaries-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('builds stdio MCP env from an allowlist plus explicit server env', () => {
    const env = createStdioMCPEnv(
      {
        GITHUB_PERSONAL_ACCESS_TOKEN: 'explicit-token',
      },
      {
        PATH: '/usr/bin',
        HOME: '/Users/test',
        OPENAI_API_KEY: 'ambient-secret',
        GITHUB_PERSONAL_ACCESS_TOKEN: 'ambient-token',
      } as NodeJS.ProcessEnv,
    );

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/test');
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('explicit-token');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('does not pass ambient process.env secrets into stdio transports', () => {
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/Users/test';
    process.env.OPENAI_API_KEY = 'ambient-secret';
    process.env.GITHUB_TOKEN = 'ambient-token';

    createTransport({
      name: 'local-test',
      command: 'node',
      args: ['server.js'],
      env: {
        MCP_SERVER_TOKEN: 'explicit-token',
      },
      enabled: true,
    });

    const options = mocks.stdioTransport.mock.calls[0][0] as { env: Record<string, string> };
    expect(options.env.PATH).toBe('/usr/bin');
    expect(options.env.MCP_SERVER_TOKEN).toBe('explicit-token');
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
  });

  it('keeps Argus disabled by default and only enables it through explicit opt-in', () => {
    delete process.env.CODE_AGENT_ENABLE_ARGUS_MCP;
    let argus = getDefaultMCPServers().find((server) => server.name === 'argus');
    expect(argus?.enabled).toBe(false);

    process.env.CODE_AGENT_ENABLE_ARGUS_MCP = '1';
    argus = getDefaultMCPServers().find((server) => server.name === 'argus');
    expect(argus?.enabled).toBe(true);
  });

  it('blocks skill reference path traversal during dependency checks and loading', async () => {
    const basePath = path.join(tmpDir, 'skill');
    await fs.mkdir(path.join(basePath, 'references'), { recursive: true });
    await fs.writeFile(path.join(basePath, 'references', 'safe.md'), 'safe', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'outside.md'), 'outside', 'utf-8');

    const skill = makeSkill(basePath, ['references/safe.md', '../outside.md']);
    const dependencies = await checkSkillDependencies(skill);
    const references = await loadSkillReferences(skill);

    expect(dependencies.satisfied).toBe(false);
    expect(dependencies.missingReferences).toContain('../outside.md');
    expect(references.get('references/safe.md')).toBe('safe');
    expect(references.has('../outside.md')).toBe(false);
  });

  it('blocks skill references that escape through symlinks', async () => {
    const basePath = path.join(tmpDir, 'skill');
    await fs.mkdir(path.join(basePath, 'references'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'outside.md'), 'outside', 'utf-8');
    await fs.symlink(path.join(tmpDir, 'outside.md'), path.join(basePath, 'references', 'link.md'));

    const skill = makeSkill(basePath, ['references/link.md']);
    const dependencies = await checkSkillDependencies(skill);
    const references = await loadSkillReferences(skill);

    expect(dependencies.satisfied).toBe(false);
    expect(dependencies.missingReferences).toEqual(['references/link.md']);
    expect(references.has('references/link.md')).toBe(false);
  });
});

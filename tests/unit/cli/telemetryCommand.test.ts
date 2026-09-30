import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { telemetryCommand } from '../../../src/cli/commands/telemetry';
import {
  TELEMETRY_PREVIEW_SESSION_ID,
  TELEMETRY_PREVIEW_USER_ID,
  buildTelemetryPreviewTurn,
  buildTelemetryTurnUploadRow,
} from '../../../src/host/telemetry/telemetryUploadRow';

interface IO {
  stdout: string[];
  stderr: string[];
}

function mockProcessIO(): IO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  return { stdout, stderr };
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.addCommand(telemetryCommand);
  return program;
}

describe('neo telemetry command', () => {
  const tempDirs: string[] = [];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let httpRequest: ReturnType<typeof vi.spyOn>;
  let httpsRequest: ReturnType<typeof vi.spyOn>;
  let httpGet: ReturnType<typeof vi.spyOn>;
  let httpsGet: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (telemetryCommand as unknown as { parent?: Command }).parent = undefined;
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    httpRequest = vi.spyOn(http, 'request');
    httpsRequest = vi.spyOn(https, 'request');
    httpGet = vi.spyOn(http, 'get');
    httpsGet = vi.spyOn(https, 'get');
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('NEO_DISABLE_TELEMETRY', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-cmd-'));
    tempDirs.push(dir);
    vi.stubEnv('CODE_AGENT_DATA_DIR', dir);
    return dir;
  }

  function expectNoNetwork(): void {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpRequest).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(httpGet).not.toHaveBeenCalled();
    expect(httpsGet).not.toHaveBeenCalled();
  }

  async function runStatus(json = false): Promise<string> {
    const io = mockProcessIO();
    const args = ['node', 'neo', 'telemetry', 'status'];
    if (json) args.push('--json');
    await makeProgram().parseAsync(args);
    expect(io.stderr.join('')).toBe('');
    return io.stdout.join('');
  }

  it('status defaults every channel on and does not create a settings file', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');

    const text = await runStatus();

    expect(fs.existsSync(configPath)).toBe(false);
    expect(text).toContain('telemetry status');
    for (const channel of ['posthog', 'cloudUpload', 'langfuse', 'crashReporting']) {
      expect(text).toMatch(new RegExp(`${channel}\\s+on\\s+source=default`));
    }
    expectNoNetwork();
  });

  it('status --json reports per-channel settings off with the settings source', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const body = `${JSON.stringify({
      privacy: {
        posthogEnabled: false,
        cloudUploadEnabled: false,
        langfuseEnabled: false,
        crashReportingEnabled: false,
      },
    }, null, 2)}\n`;
    fs.writeFileSync(configPath, body);

    const parsed = JSON.parse(await runStatus(true)) as Record<string, { enabled: boolean; source: string }>;

    expect(fs.readFileSync(configPath, 'utf8')).toBe(body);
    expect(parsed.posthog).toEqual({ enabled: false, source: 'settings.privacy.posthogEnabled' });
    expect(parsed.cloudUpload).toEqual({ enabled: false, source: 'settings.privacy.cloudUploadEnabled' });
    expect(parsed.langfuse).toEqual({ enabled: false, source: 'settings.privacy.langfuseEnabled' });
    expect(parsed.crashReporting).toEqual({ enabled: false, source: 'settings.privacy.crashReportingEnabled' });
    expectNoNetwork();
  });

  it('status reports legacy usageDataEnabled:false for the three usage channels', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      privacy: { usageDataEnabled: false },
    }));

    const text = await runStatus();

    expect(text).toMatch(/posthog\s+off\s+source=legacy:usageDataEnabled/);
    expect(text).toMatch(/cloudUpload\s+off\s+source=legacy:usageDataEnabled/);
    expect(text).toMatch(/langfuse\s+off\s+source=legacy:usageDataEnabled/);
    expect(text).toMatch(/crashReporting\s+on\s+source=default/);
    expectNoNetwork();
  });

  it('status lets DO_NOT_TRACK win over settings that are on', async () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const body = JSON.stringify({
      privacy: {
        posthogEnabled: true,
        cloudUploadEnabled: true,
        langfuseEnabled: true,
        crashReportingEnabled: true,
      },
    });
    fs.writeFileSync(configPath, body);
    vi.stubEnv('DO_NOT_TRACK', '1');
    vi.stubEnv('NEO_DISABLE_TELEMETRY', 'true');

    const parsed = JSON.parse(await runStatus(true)) as Record<string, { enabled: boolean; source: string }>;
    (telemetryCommand as unknown as { parent?: Command }).parent = undefined;
    const textIo = mockProcessIO();
    await makeProgram().parseAsync(['node', 'neo', 'telemetry', 'status']);
    const text = textIo.stdout.join('');

    expect(fs.readFileSync(configPath, 'utf8')).toBe(body);
    for (const channel of ['posthog', 'cloudUpload', 'langfuse', 'crashReporting']) {
      expect(parsed[channel]).toEqual({ enabled: false, source: 'env:DO_NOT_TRACK' });
      expect(text).toMatch(new RegExp(`${channel}\\s+off\\s+source=env:DO_NOT_TRACK`));
    }
    expectNoNetwork();
  });

  it('status reports NEO_DISABLE_TELEMETRY when DO_NOT_TRACK is absent', async () => {
    makeTempDir();
    vi.stubEnv('NEO_DISABLE_TELEMETRY', ' TRUE ');

    const text = await runStatus();

    expect(text).toMatch(/cloudUpload\s+off\s+source=env:NEO_DISABLE_TELEMETRY/);
    expectNoNetwork();
  });

  it('preview prints the real upload envelope and makes no network call', async () => {
    makeTempDir();
    const io = mockProcessIO();
    const homeDir = os.homedir();

    await makeProgram().parseAsync(['node', 'neo', 'telemetry', 'preview']);

    const stdout = io.stdout.join('');
    const envelope = JSON.parse(stdout) as unknown;
    expect(envelope).toEqual(buildTelemetryTurnUploadRow(
      buildTelemetryPreviewTurn(homeDir),
      TELEMETRY_PREVIEW_SESSION_ID,
      TELEMETRY_PREVIEW_USER_ID,
      homeDir,
    ));
    expect(stdout).not.toContain('NEO_PREVIEW_PLANTED_PROMPT');
    expect(stdout).not.toContain('NEO_PREVIEW_PLANTED_TOOL_CONTENT');
    expect(stdout).not.toContain(homeDir);
    expect(stdout).toContain('~/neo-preview-secret');
    expectNoNetwork();
  });

  it('preview --json is the same envelope', async () => {
    makeTempDir();
    const io = mockProcessIO();
    await makeProgram().parseAsync(['node', 'neo', 'telemetry', 'preview', '--json']);
    const stdout = io.stdout.join('').trim();
    expect(stdout.startsWith('{')).toBe(true);
    expect(stdout).not.toContain('\n');
    expect(JSON.parse(stdout)).toEqual(buildTelemetryTurnUploadRow(
      buildTelemetryPreviewTurn(os.homedir()),
      TELEMETRY_PREVIEW_SESSION_ID,
      TELEMETRY_PREVIEW_USER_ID,
      os.homedir(),
    ));
    expectNoNetwork();
  });

  it('wires telemetry into the CLI lightweight route', () => {
    const indexSource = fs.readFileSync(
      path.join(__dirname, '../../../src/cli/index.ts'),
      'utf-8',
    );
    const metadataBlock = indexSource.slice(
      indexSource.indexOf('if (metadataOnly)'),
      indexSource.indexOf("requestedCommand === 'policy'"),
    );
    expect(metadataBlock).toContain("'telemetry'");
    const telemetryBranch = indexSource.slice(
      indexSource.indexOf("requestedCommand === 'telemetry'"),
      indexSource.indexOf("requestedCommand !== 'session'"),
    );
    expect(telemetryBranch).toContain("import('./commands/telemetry')");
    expect(telemetryBranch).not.toContain("import('./commands/chat')");
    expect(telemetryBranch).not.toContain("import('./commands/run')");
  });
});

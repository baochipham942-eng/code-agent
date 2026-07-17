import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error —— 纯 JS 释放门脚本，无类型声明
import { generateControlPlaneEnvBundle } from '../../scripts/generate-control-plane-env.mjs';

describe('control-plane env bundle generator', () => {
  it('writes key material, locked payloads, and vercel commands without touching production', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'code-agent-control-plane-env-test-'));

    const result = generateControlPlaneEnvBundle({
      outDir,
      keyId: 'test-key',
      version: 'test-version',
      now: new Date('2026-05-17T00:00:00.000Z'),
    });

    expect(result.targetDir).toBe(outDir);
    expect(result.files.map((file: string) => file.replace(`${outDir}/`, ''))).toContain('private.pem');
    expect(result.files.map((file: string) => file.replace(`${outDir}/`, ''))).toContain('control-plane-key-id.txt');
    expect(result.files.map((file: string) => file.replace(`${outDir}/`, ''))).toContain('control-plane-ttl-seconds.txt');
    expect(readFileSync(join(outDir, 'private.pem'), 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect(readFileSync(join(outDir, 'public.pem'), 'utf8')).toContain('BEGIN PUBLIC KEY');
    expect(readFileSync(join(outDir, 'control-plane-key-id.txt'), 'utf8')).toBe('test-key\n');
    expect(readFileSync(join(outDir, 'control-plane-ttl-seconds.txt'), 'utf8')).toBe('3600\n');
    expect(statSync(join(outDir, 'private.pem')).mode & 0o777).toBe(0o600);

    const cloudConfig = JSON.parse(readFileSync(join(outDir, 'cloud-config.json'), 'utf8')) as {
      version: string;
      entitlement: { status: string; capabilities: string[] };
    };
    expect(cloudConfig.version).toBe('test-version');
    expect(cloudConfig.entitlement).toMatchObject({
      status: 'revoked',
      capabilities: [],
    });

    const agentEngineCatalog = JSON.parse(readFileSync(join(outDir, 'agent-engine-model-catalog.json'), 'utf8')) as {
      version: string;
      engines: Array<{ kind: string; defaultModel: string; models: Array<{ id: string }> }>;
    };
    expect(agentEngineCatalog).toMatchObject({
      version: 'test-version',
      engines: [
        { kind: 'codex_cli', defaultModel: 'gpt-5.5' },
        { kind: 'claude_code', defaultModel: 'sonnet' },
      ],
    });
    expect(
      agentEngineCatalog.engines.find((engine) => engine.kind === 'claude_code')?.models.map((model) => model.id),
    ).toEqual(expect.arrayContaining(['sonnet', 'fable', 'opus', 'haiku']));

    const rendererRollout = JSON.parse(readFileSync(join(outDir, 'renderer-bundle-rollout.json'), 'utf8')) as {
      version: string;
      channel: string;
      rolloutPercent: number;
    };
    expect(rendererRollout).toEqual({
      version: 'test-version',
      channel: 'latest',
      rolloutPercent: 100,
    });

    const commands = readFileSync(join(outDir, 'vercel-env-commands.txt'), 'utf8');
    expect(commands).toContain(`cd '${process.cwd()}'`);
    expect(commands).toContain('vercel env add CONTROL_PLANE_PRIVATE_KEY production');
    expect(commands).toContain(`CONTROL_PLANE_KEY_ID production --force --yes < '${outDir}/control-plane-key-id.txt'`);
    expect(commands).toContain(`CONTROL_PLANE_TTL_SECONDS production --force --yes < '${outDir}/control-plane-ttl-seconds.txt'`);
    expect(commands).toContain('CONTROL_PLANE_AGENT_ENGINE_MODEL_CATALOG_JSON');
    expect(commands).toContain('CONTROL_PLANE_RENDERER_BUNDLE_ROLLOUT_JSON');
    expect(commands).toContain('vercel env add CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS production');
    expect(commands).not.toContain('--value');
    expect(commands).not.toContain('BEGIN PRIVATE KEY');

    const postApplyCommands = readFileSync(join(outDir, 'post-apply-commands.txt'), 'utf8');
    expect(postApplyCommands).toContain(`cd '${process.cwd()}'`);
    expect(postApplyCommands).toContain('vercel deploy --prod --yes');
    expect(postApplyCommands).toContain('npm run renderer:verify-production -- --expected-version-from-app-update --include-remote-snapshot --retry-attempts 12 --retry-delay-ms 30000');
    expect(postApplyCommands).not.toContain('BEGIN PRIVATE KEY');
  });
});

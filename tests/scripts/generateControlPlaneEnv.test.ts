import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    expect(result.files.map((file) => file.replace(`${outDir}/`, ''))).toContain('private.pem');
    expect(readFileSync(join(outDir, 'private.pem'), 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect(readFileSync(join(outDir, 'public.pem'), 'utf8')).toContain('BEGIN PUBLIC KEY');
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
      engines: Array<{ kind: string; defaultModel: string }>;
    };
    expect(agentEngineCatalog).toMatchObject({
      version: 'test-version',
      engines: [
        { kind: 'codex_cli', defaultModel: 'gpt-5' },
        { kind: 'claude_code', defaultModel: 'sonnet' },
      ],
    });

    const commands = readFileSync(join(outDir, 'vercel-env-commands.txt'), 'utf8');
    expect(commands).toContain('vercel env add CONTROL_PLANE_PRIVATE_KEY production');
    expect(commands).toContain('CONTROL_PLANE_AGENT_ENGINE_MODEL_CATALOG_JSON');
    expect(commands).toContain('vercel env add CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS production');
    expect(commands).not.toContain('BEGIN PRIVATE KEY');
  });
});

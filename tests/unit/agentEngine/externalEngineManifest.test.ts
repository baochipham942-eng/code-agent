import { describe, expect, it } from 'vitest';
import {
  getExternalEngineManifestForKind,
  listExternalEngineManifests,
} from '../../../src/shared/externalEngineManifest';

describe('external engine manifest contract', () => {
  it('keeps supported execution kinds backed by production adapters', () => {
    for (const kind of [
      'codex_cli',
      'claude_code',
      'mimo_code',
      'kimi_code',
      'codebuddy_code',
      'grok_cli',
    ] as const) {
      const manifest = getExternalEngineManifestForKind(kind);
      expect(manifest).toMatchObject({
        kind,
        adapter: {
          adapterId: kind,
          credentialOwner: 'official_client',
          evidence: 'production',
        },
      });
      expect(manifest?.probe?.commands.length).toBeGreaterThan(0);
    }
  });

  it('allows adding recommendation/probe manifests without adding a session kind or core-page branch', () => {
    const manifests = listExternalEngineManifests();
    const recommendationOnly = manifests.filter((manifest) => !manifest.kind);

    expect(manifests).toHaveLength(10);
    expect(recommendationOnly.map((manifest) => manifest.id)).toEqual([
      'qoder_work',
      'comate_zulu',
      'cursor_cli',
    ]);
    expect(recommendationOnly.every((manifest) => !manifest.adapter.adapterId)).toBe(true);
  });

  it('never stores official credentials or entitlement marketing claims in manifests', () => {
    const serialized = JSON.stringify(listExternalEngineManifests()).toLowerCase();
    expect(serialized).not.toMatch(/api[_-]?key\s*[:=]\s*['"][^'"]+/);
    expect(serialized).not.toContain('限免');
    expect(serialized).not.toContain('免费半个月');
  });

  it('keeps WorkBuddy on the client default when its current CLI cannot enumerate models', () => {
    const manifest = getExternalEngineManifestForKind('codebuddy_code');

    expect(manifest).toMatchObject({
      label: 'WorkBuddy',
      modelSelection: 'client_default',
    });
    expect(manifest?.probe?.modelDiscovery).toBeUndefined();
  });

  it('uses the official Kimi CLI for auth and runtime model discovery', () => {
    const manifest = getExternalEngineManifestForKind('kimi_code');

    expect(manifest).toMatchObject({
      label: 'Kimi Code',
      modelSelection: 'runtime_catalog',
      probe: {
        authProbe: {
          args: ['provider', 'list', '--json'],
          successPattern: '"managed:kimi-code"',
        },
        modelDiscovery: {
          args: ['provider', 'list', '--json'],
          parser: 'model_map_json',
          modelMapKey: 'models',
          labelField: 'displayName',
          merge: 'replace',
        },
      },
    });
  });

  it('adds Qoder Work as a detectable login-gated spike without claiming execution', () => {
    const manifest = listExternalEngineManifests()
      .find((entry) => entry.id === 'qoder_work');

    expect(manifest).toMatchObject({
      label: 'Qoder Work',
      modelSelection: 'unavailable',
      probe: {
        commands: ['qoderclicn'],
        authProbe: {
          args: ['status'],
          successPattern: 'Account:',
          failurePattern: 'Not logged in',
        },
      },
      adapter: {
        transport: 'cli',
        credentialOwner: 'official_client',
        evidence: 'local_spike',
      },
      capabilities: [],
    });
    expect(manifest).not.toHaveProperty('kind');
    expect(manifest?.adapter.adapterId).toBeUndefined();
  });

  it('uses official Grok login and model probes without owning credentials', () => {
    const manifest = getExternalEngineManifestForKind('grok_cli');

    expect(manifest).toMatchObject({
      label: 'Grok Build',
      modelSelection: 'runtime_catalog',
      probe: {
        commands: ['grok'],
        timeoutMs: 12_000,
        authProbe: {
          args: ['models'],
          successPattern: 'You are logged in with grok.com.',
        },
        modelDiscovery: {
          args: ['models'],
          parser: 'grok_models_text',
          merge: 'replace',
        },
      },
      adapter: {
        adapterId: 'grok_cli',
        credentialOwner: 'official_client',
        evidence: 'production',
      },
    });
  });
});

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

    // 12 = 8 个可执行 kind + 3 个仅推荐 + native。
    expect(manifests).toHaveLength(12);
    expect(recommendationOnly.map((manifest) => manifest.id)).toEqual([
      'qoder_work',
      'comate_zulu',
      'cursor_cli',
    ]);
    expect(recommendationOnly.every((manifest) => !manifest.adapter.adapterId)).toBe(true);
  });

  /**
   * 🔴 registry 把 `evidence === 'production'` 当成 executable/selectable 的必要条件
   * （agentEngineRegistry.buildEngineDescriptor / buildSourceDescriptor）。
   * 于是「有 adapter 但 evidence 填了 local_spike」的条目会在设置里可见、
   * capabilities 却是空数组，选中就抛 capability 错——典型的装好没接电。
   * 2026-08-27 加 kimi_code_acp 时真踩到过一次，这里把它钉住。
   */
  it('keeps every adapter-backed manifest executable (evidence must be production)', () => {
    // 上面那条同族断言是**按引擎名字写死的清单**，dsh_cli 本来就漏在外面，
    // 新引擎也一律逃逸（2026-08-27 kimi_code_acp 就是这样溜过去的）。
    // 这条改成从数据推导，覆盖当前与未来所有带 adapter 的条目。
    const adapterBacked = listExternalEngineManifests()
      .filter((manifest) => manifest.adapter.adapterId && manifest.kind !== 'native');

    expect(adapterBacked.length).toBeGreaterThan(0);
    for (const manifest of adapterBacked) {
      expect(
        manifest.adapter.evidence,
        `${manifest.id} has an adapterId but non-production evidence, so the registry would mark it non-executable`,
      ).toBe('production');
      expect(manifest.adapter.adapterId, `${manifest.id} adapterId must equal its kind`).toBe(manifest.kind);
      expect(manifest.capabilities, `${manifest.id} must declare execute`).toContain('execute');
      expect(manifest.probe?.commands.length ?? 0, `${manifest.id} needs a probe command`).toBeGreaterThan(0);
    }
  });

  it('never stores official credentials or entitlement marketing claims in manifests', () => {
    const serialized = JSON.stringify(listExternalEngineManifests()).toLowerCase();
    expect(serialized).not.toMatch(/api[_-]?key\s*[:=]\s*['"][^'"]+/);
    expect(serialized).not.toContain('限免');
    expect(serialized).not.toContain('免费半个月');
  });

  it('keeps declared capabilities aligned with distinct host implementations', () => {
    const capabilitiesByKind = Object.fromEntries(
      listExternalEngineManifests()
        .filter((manifest) => manifest.kind)
        .map((manifest) => [manifest.kind, manifest.capabilities]),
    );

    expect(capabilitiesByKind).toEqual({
      native: ['execute', 'stream_events', 'resume'],
      codex_cli: ['execute', 'stream_events', 'resume', 'workspace_write'],
      claude_code: ['execute', 'stream_events', 'resume', 'workspace_write'],
      mimo_code: ['execute', 'stream_events'],
      kimi_code: ['execute', 'stream_events'],
      codebuddy_code: ['execute', 'stream_events'],
      grok_cli: ['execute', 'stream_events'],
      dsh_cli: ['execute', 'stream_events', 'resume'],
      // ACP 形态：resume 走 session/load（实测），workspace_write 因写盘在 Neo 侧且逐次过审批链。
      kimi_code_acp: ['execute', 'stream_events', 'resume', 'workspace_write'],
    });
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

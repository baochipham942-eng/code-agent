import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRendererShellCapabilities } from '../../../scripts/renderer-capability-scanner.mjs';
import { getShellCapabilities, getShellCapabilityIds } from '../../../src/host/shellCapabilities';
import { makeShellCapabilityId, makeTauriCommandCapabilityId } from '../../../src/shared/contract/shellCapabilities';

describe('shell capabilities', () => {
  it('covers static shell invocations used by the current renderer', () => {
    const repoRoot = process.cwd();
    const detected = collectRendererShellCapabilities({
      rendererDir: path.join(repoRoot, 'src/renderer'),
      domainsPath: path.join(repoRoot, 'src/shared/ipc/domains.ts'),
      repoRoot,
    });
    const supported = new Set(getShellCapabilityIds());
    const missing = detected
      .filter((capability: { id: string; file: string }) => !supported.has(capability.id))
      .map((capability: { id: string; file: string }) => `${capability.id} (${capability.file})`);

    expect(missing).toEqual([]);
  });

  it.each([
    ['domain:agentEngine', 'listSources'],
    ['domain:project', 'artifactIssues'],
    ['domain:project', 'listCloudCards'],
    ['domain:project', 'resyncCloudCards'],
    ['domain:project', 'setDescription'],
    ['domain:queuedInput', 'reorder'],
    ['domain:queuedInput', 'sendNow'],
    ['domain:queuedInput', 'update'],
    ['domain:settings', 'saveProviderIconAsset'],
    ['domain:settings', 'resolveProviderIconAsset'],
    ['domain:settings', 'getBudgetStatus'],
    ['domain:settings', 'setBudgetConfig'],
    ['domain:connector', 'oauthSaveDescriptor'],
    ['domain:provider', 'list_realtime_voice_providers'],
    ['domain:provider', 'save_realtime_voice_provider'],
    ['domain:provider', 'test_realtime_voice_provider'],
    ['domain:memory', 'memoryEntryUpdate'],
    ['domain:session', 'restoreWorkspaceFilesAtCheckpoint'],
    ['domain:session', 'turnCheckout'],
    ['domain:session', 'turnRedo'],
    ['domain:surfaceExecution', 'control'],
    ['domain:surfaceExecution', 'deletePersistedTerminalFrames'],
    ['domain:surfaceExecution', 'getFrame'],
    ['domain:surfaceExecution', 'getOutput'],
    ['domain:surfaceExecution', 'getPersistedTerminalFrame'],
    ['domain:surfaceExecution', 'getSnapshot'],
    ['domain:surfaceExecution', 'persistTerminalFrame'],
    ['domain:voice', 'reportFailure'],
    ['domain:workspace', 'getFileMetadata'],
  ])('advertises newly registered handler %s/%s in the capability manifest', (domain, action) => {
    const supported = new Set(getShellCapabilityIds());
    expect(supported.has(makeShellCapabilityId(domain, action))).toBe(true);
  });

  it('advertises native Tauri commands that renderer hot updates can require', () => {
    const supported = new Set(getShellCapabilityIds());

    expect(supported.has(makeTauriCommandCapabilityId('desktop_get_capabilities'))).toBe(true);
    expect(supported.has(makeTauriCommandCapabilityId('appshots_read_image_data_url'))).toBe(true);
    expect(supported.has(makeTauriCommandCapabilityId('pip_show'))).toBe(true);
    expect(supported.has(makeTauriCommandCapabilityId('install_update'))).toBe(true);
    expect(supported.has(makeTauriCommandCapabilityId('renderer_ready'))).toBe(true);
  });

  it('labels shell capabilities by hot-update layer', () => {
    const capabilities = getShellCapabilities();
    expect(capabilities.find((capability) => capability.id === 'domain:update/check')).toMatchObject({
      layer: 'domain',
    });
    expect(capabilities.find((capability) => capability.id === makeTauriCommandCapabilityId('desktop_get_capabilities'))).toMatchObject({
      layer: 'native',
    });
  });

  it('marks workspace file restore as a high-risk shell mutation', () => {
    expect(getShellCapabilities().find((capability) => (
      capability.id === makeShellCapabilityId(
        'domain:session',
        'restoreWorkspaceFilesAtCheckpoint',
      )
    ))).toMatchObject({
      risk: 'high',
    });
  });

  it('marks custom OAuth descriptor changes as a high-risk shell mutation', () => {
    expect(getShellCapabilities().find((capability) => (
      capability.id === makeShellCapabilityId('domain:connector', 'oauthSaveDescriptor')
    ))).toMatchObject({ risk: 'high' });
  });

  it.each(['turnCheckout', 'turnRedo'])('marks %s as a high-risk shell mutation', (action) => {
    expect(getShellCapabilities().find((capability) => (
      capability.id === makeShellCapabilityId('domain:session', action)
    ))).toMatchObject({ risk: 'high' });
  });

  it('marks cloud card resync as a medium-risk shell mutation', () => {
    expect(getShellCapabilities().find((capability) => (
      capability.id === makeShellCapabilityId('domain:project', 'resyncCloudCards')
    ))).toMatchObject({
      risk: 'medium',
    });
  });

  // ── inferRisk 判据形状：动词按 camelCase 词段匹配，不只看前缀 ──────────────
  // 旧判据 /^(add|…|set|…)/ 只认词首，写库动作只要动词不在开头就静默落 low。
  it.each([
    ['domain:memory', 'memoryEntryDelete'],
    ['domain:memory', 'lightDelete'],
    ['domain:memory', 'memoryImportV2Apply'],
    ['domain:roles', 'rolePackInstall'],
    ['domain:team', 'recipeDelete'],
    ['domain:data', 'cacheClear'],
    ['domain:voice', 'voiceprintClear'],
  ])('marks %s/%s as medium: 写动词在词中也要算', (domain, action) => {
    expect(getShellCapabilities().find((capability) => (
      capability.id === makeShellCapabilityId(domain, action)
    ))).toMatchObject({ risk: 'medium' });
  });

  // 只读首词优先：get/list/check/inspect 开头的查询即便名字里含写动词词段也是 low，
  // 否则 getAudioCaptureStatus 会因为 capture、check_for_update 会因为 update 被误升。
  it.each([
    ['domain:desktop', 'getAudioCaptureStatus'],
    ['domain:workspace', 'inspectArchive'],
  ])('keeps %s/%s low: 只读首词压过词中写动词', (domain, action) => {
    expect(getShellCapabilities().find((capability) => (
      capability.id === makeShellCapabilityId(domain, action)
    ))).toMatchObject({ risk: 'low' });
  });

  // 旧判据 /^set/ 无词边界，把 pii 的 setup:* 全吃成 medium；实际 setup:status →
  // getStatus()、setup:isReady → checkReady() 是纯查询，而 setup:start/cancel 真的写。
  it('fixes the ^set false positive on pii setup:* wire actions', () => {
    const caps = getShellCapabilities();
    const riskOf = (action: string) => caps.find((c) => (
      c.id === makeShellCapabilityId('domain:pii', action)
    ))?.risk;
    expect(riskOf('setup:status')).toBe('low');
    expect(riskOf('setup:isReady')).toBe('low');
    expect(riskOf('setup:start')).toBe('medium');
    expect(riskOf('setup:cancel')).toBe('medium');
  });

  // 判据够不着的写动作，钉在这里当回归保护：resolveConflict（同步冲突解决）与
  // exportSessionFork（会话分叉导出）都是写动作，却判 low —— 真因是 resolve / conflict /
  // export / fork 都不在 MUTATION_VERBS 里，判据天然给不出 medium；与改判据前的基线一致
  // （旧前缀规则同样给 low），不是回归。
  // 这条断言钉的是「它们目前是 low」这个事实：谁往写动词表加 resolve/export/fork，或把
  // 它们补进 HIGH_RISK_CAPABILITIES，这条会红，提醒他同步更新文档并跑一次全量对拍。
  it.each([
    ['domain:sync', 'resolveConflict'],
    ['domain:session', 'exportSessionFork'],
  ])('pins the known under-classification: %s/%s stays low', (domain, action) => {
    expect(getShellCapabilities().find((capability) => (
      capability.id === makeShellCapabilityId(domain, action)
    ))).toMatchObject({ risk: 'low' });
  });
});

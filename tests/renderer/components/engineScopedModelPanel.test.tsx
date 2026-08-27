// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEngineKind,
  AgentEngineModelCatalog,
  AgentEngineSourceDescriptor,
} from '../../../src/shared/contract/agentEngine';
import { AGENT_ENGINE_LABELS } from '../../../src/shared/contract/agentEngine';
import {
  EngineScopedModelPanel,
  filterEngineSources,
} from '../../../src/renderer/components/StatusBar/EngineScopedModelPanel';
import { shouldDismissModelSwitcher } from '../../../src/renderer/components/StatusBar/ModelSwitcher';
import { loadEnginePanelData } from '../../../src/renderer/components/StatusBar/enginePanelLoader';

const sources: AgentEngineSourceDescriptor[] = [
  ['native', 'native', 'Neo', true],
  ['codex_cli', 'codex_cli', 'Codex CLI', true],
  ['claude_code', 'claude_code', 'Claude Code', true],
  ['mimo_code', 'mimo_code', 'MiMo-Code', true],
  ['kimi_code', 'kimi_code', 'Kimi Code', true],
  ['codebuddy_code', 'codebuddy_code', 'WorkBuddy', true],
  ['grok_cli', 'grok_cli', 'Grok Build', true],
  ['qoder_work', undefined, 'Qoder Work', false],
  ['comate_zulu', undefined, 'Comate / Zulu', false],
  ['cursor_cli', undefined, 'Cursor CLI', false],
].map(([manifestId, kind, label, selectable]) => ({
  manifestId: String(manifestId),
  ...(kind ? { kind: kind as AgentEngineSourceDescriptor['kind'] } : {}),
  label: String(label),
  summary: `${label} summary`,
  detected: Boolean(selectable),
  selectable: Boolean(selectable),
  authState: selectable ? 'authenticated' : 'not_checked',
  modelSelection: kind === 'mimo_code'
    ? 'client_default'
    : kind === 'native'
      ? 'neo_provider'
      : kind
        ? 'runtime_catalog'
        : 'unavailable',
  ...(manifestId === 'native' ? { iconAsset: '/code-agent/agent-neo-mark.svg' } : {}),
  evidence: selectable ? 'production' : 'none',
  credentialOwner: kind === 'native' ? 'neo' : 'official_client',
  auditNotes: [],
})) as AgentEngineSourceDescriptor[];

const catalog: AgentEngineModelCatalog = {
  version: 'fixture',
  updatedAt: '2026-07-30T00:00:00.000Z',
  engines: [
    {
      kind: 'codex_cli',
      defaultModel: 'gpt-5.5',
      models: [
        { id: 'gpt-5.5', label: 'GPT-5.5', capabilities: ['code'], recommended: true },
        { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', capabilities: ['code', 'fast'] },
      ],
    },
    {
      kind: 'codebuddy_code',
      defaultModel: 'auto',
      models: [
        { id: 'auto', label: 'Auto', capabilities: ['code'], recommended: true },
        { id: 'kimi-k2.5', label: 'Kimi K2.5', capabilities: ['code', 'reasoning'] },
      ],
    },
    {
      kind: 'kimi_code',
      defaultModel: 'kimi-code/k3',
      models: [
        { id: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding', capabilities: ['code', 'reasoning'] },
        { id: 'kimi-code/k3', label: 'K3', capabilities: ['code', 'reasoning', 'longContext'], recommended: true },
      ],
    },
    {
      kind: 'grok_cli',
      defaultModel: 'grok-4.5',
      models: [
        { id: 'grok-4.5', label: 'Grok 4.5', capabilities: ['code', 'reasoning'], recommended: true },
      ],
    },
  ],
};

const noop = () => {};

afterEach(cleanup);

describe('engine-scoped model panel', () => {
  it('renders a truthful skeleton while the model catalog is loading', () => {
    render(
      <EngineScopedModelPanel
        view="models"
        sources={sources}
        modelCatalogLoading
        catalog={null}
        currentEngine="kimi_code_acp"
        query=""
        onQueryChange={noop}
        onViewChange={noop}
        onSelectEngine={noop}
        onSelectExternalModel={noop}
        onOpenSettings={noop}
        onRetryCatalog={noop}
      />,
    );

    expect(document.querySelector('[data-current-external-model]')?.textContent)
      .toBe('正在读取模型列表…');
    expect(document.querySelectorAll('[data-model-catalog-skeleton="search"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-model-catalog-skeleton="row"]')).toHaveLength(3);
    expect(document.body.textContent).not.toContain('不可用');
    expect(document.body.textContent).not.toContain('验证');
    expect(document.body.textContent).not.toContain('kimi_code_acp');
  });

  it('renders a real retry and settings exit after catalog loading fails', () => {
    const onRetryCatalog = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <EngineScopedModelPanel
        view="models"
        sources={sources}
        modelCatalogFailed
        catalog={null}
        currentEngine="kimi_code_acp"
        query=""
        onQueryChange={noop}
        onViewChange={noop}
        onSelectEngine={noop}
        onSelectExternalModel={noop}
        onOpenSettings={onOpenSettings}
        onRetryCatalog={onRetryCatalog}
      />,
    );

    expect(screen.getByText(
      '暂时连不上 Kimi Code (ACP)，模型列表加载失败。请检查网络后点「重试」；若多次失败，可到「设置 → 引擎」重新连接。',
    )).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetryCatalog).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '设置 → 引擎' }));
    expect(onOpenSettings).toHaveBeenCalledWith('agentEngine');
  });

  it.each(Object.entries(AGENT_ENGINE_LABELS).filter(([kind]) => kind !== 'native'))(
    'never exposes internal engine kind %s when source discovery has not returned',
    (kind, label) => {
      render(
        <EngineScopedModelPanel
          view="models"
          sources={[]}
          engineSourcesLoading
          modelCatalogLoading
          catalog={null}
          currentEngine={kind as AgentEngineKind}
          query=""
          onQueryChange={noop}
          onViewChange={noop}
          onSelectEngine={noop}
          onSelectExternalModel={noop}
          onOpenSettings={noop}
          onRetryCatalog={noop}
        />,
      );

      expect(screen.getByText(label)).toBeTruthy();
      expect(document.body.textContent).not.toContain(kind);
    },
  );

  it('supports a searchable, scrollable list with ten engine sources', () => {
    const onQueryChange = vi.fn();
    const { rerender } = render(
      <EngineScopedModelPanel
        view="engines"
        sources={sources}
        catalog={catalog}
        currentEngine="native"
        query=""
        onQueryChange={onQueryChange}
        onViewChange={noop}
        onSelectEngine={noop}
        onSelectExternalModel={noop}
        onOpenSettings={noop}
        onRetryCatalog={noop}
      />,
    );

    expect(document.querySelectorAll('[data-engine-source]')).toHaveLength(10);
    expect(document.querySelector('[data-engine-scroll-list]')?.className).toContain('overflow-y-auto');
    fireEvent.change(screen.getByPlaceholderText('搜索执行引擎…'), { target: { value: 'cursor' } });
    expect(onQueryChange).toHaveBeenCalledWith('cursor');

    rerender(
      <EngineScopedModelPanel
        view="engines"
        sources={sources}
        catalog={catalog}
        currentEngine="native"
        query="cursor"
        onQueryChange={onQueryChange}
        onViewChange={noop}
        onSelectEngine={noop}
        onSelectExternalModel={noop}
        onOpenSettings={noop}
        onRetryCatalog={noop}
      />,
    );
    expect(document.querySelectorAll('[data-engine-source]')).toHaveLength(1);
    expect(screen.getByText('Cursor CLI')).toBeTruthy();
  });

  it('renders only runtime-discovered models and sends the selected engine/model pair', () => {
    const onSelectExternalModel = vi.fn();
    render(
      <EngineScopedModelPanel
        view="models"
        sources={sources}
        catalog={catalog}
        currentEngine="codex_cli"
        currentModel="gpt-5.5"
        query=""
        onQueryChange={noop}
        onViewChange={noop}
        onSelectEngine={noop}
        onSelectExternalModel={onSelectExternalModel}
        onOpenSettings={noop}
        onRetryCatalog={noop}
      />,
    );

    expect(document.querySelectorAll('[data-external-model]')).toHaveLength(2);
    expect(document.querySelector('[data-model-catalog-loading]')).toBeNull();
    expect(document.querySelector('[data-model-catalog-unavailable]')).toBeNull();
    fireEvent.click(screen.getByText('GPT-5.4 Mini'));
    expect(onSelectExternalModel).toHaveBeenCalledWith('codex_cli', 'gpt-5.4-mini');
  });

  it('lets WorkBuddy switch among locally discovered models', () => {
    const onSelectExternalModel = vi.fn();
    render(
      <EngineScopedModelPanel
        view="models"
        sources={sources}
        catalog={catalog}
        currentEngine="codebuddy_code"
        currentModel="auto"
        query=""
        onQueryChange={noop}
        onViewChange={noop}
        onSelectEngine={noop}
        onSelectExternalModel={onSelectExternalModel}
        onOpenSettings={noop}
        onRetryCatalog={noop}
      />,
    );

    expect(document.querySelector('[data-current-external-model]')?.textContent).toBe('Auto · auto');
    fireEvent.click(screen.getByText('Kimi K2.5'));
    expect(onSelectExternalModel).toHaveBeenCalledWith('codebuddy_code', 'kimi-k2.5');
  });

  it('states client-default honestly and keeps every icon in the 32px slot contract', () => {
    render(
      <EngineScopedModelPanel
        view="models"
        sources={sources}
        catalog={catalog}
        currentEngine="mimo_code"
        query=""
        onQueryChange={noop}
        onViewChange={noop}
        onSelectEngine={noop}
        onSelectExternalModel={noop}
        onOpenSettings={noop}
        onRetryCatalog={noop}
      />,
    );

    expect(screen.getByText('由官方客户端选择默认模型')).toBeTruthy();
    const slot = document.querySelector('[data-engine-icon-slot]');
    expect(slot?.className).toContain('h-8');
    expect(slot?.className).toContain('w-8');
    // 无 iconAsset 的引擎回退成「首字母品牌色瓦片」（2026-08-05：满屏同一终端图标读作都没有 logo）
    expect(slot?.textContent).toBe('M');
    expect(slot?.querySelector('span')?.className).toContain('rounded-lg');
  });

  it('shows the detected Kimi model name in the popup header and allows switching it', () => {
    const onSelectExternalModel = vi.fn();
    render(
      <EngineScopedModelPanel
        view="models"
        sources={sources}
        catalog={catalog}
        currentEngine="kimi_code"
        currentModel="kimi-code/k3"
        query=""
        onQueryChange={noop}
        onViewChange={noop}
        onSelectEngine={noop}
        onSelectExternalModel={onSelectExternalModel}
        onOpenSettings={noop}
        onRetryCatalog={noop}
      />,
    );

    expect(document.querySelector('[data-current-external-model]')?.textContent)
      .toContain('K3 · kimi-code/k3');
    fireEvent.click(screen.getByText('K2.7 Coding'));
    expect(onSelectExternalModel).toHaveBeenCalledWith(
      'kimi_code',
      'kimi-code/kimi-for-coding',
    );
  });

  it('shows only the real Grok model returned by local discovery', () => {
    const onSelectExternalModel = vi.fn();
    render(
      <EngineScopedModelPanel
        view="models"
        sources={sources}
        catalog={catalog}
        currentEngine="grok_cli"
        currentModel="grok-4.5"
        query=""
        onQueryChange={noop}
        onViewChange={noop}
        onSelectEngine={noop}
        onSelectExternalModel={onSelectExternalModel}
        onOpenSettings={noop}
        onRetryCatalog={noop}
      />,
    );

    expect(document.querySelector('[data-current-external-model]')?.textContent)
      .toContain('Grok 4.5 · grok-4.5');
    expect(document.querySelectorAll('[data-external-model]')).toHaveLength(1);
    fireEvent.click(screen.getByText('Grok 4.5'));
    expect(onSelectExternalModel).toHaveBeenCalledWith('grok_cli', 'grok-4.5');
  });
});

describe('engine panel request independence', () => {
  it('settles fast engine sources before the cold model catalog returns', async () => {
    let resolveSources: ((value: unknown) => void) | undefined;
    let resolveCatalog: ((value: unknown) => void) | undefined;
    const listSources = vi.fn(() => new Promise((resolve) => { resolveSources = resolve; }));
    const listModels = vi.fn(() => new Promise((resolve) => { resolveCatalog = resolve; }));
    const onSourcesLoadingChange = vi.fn();
    const onCatalogLoadingChange = vi.fn();
    const onSourcesLoaded = vi.fn();
    const onCatalogLoaded = vi.fn();

    const cancel = loadEnginePanelData({
      listSources: listSources as never,
      listModels: listModels as never,
      onSourcesLoadingChange,
      onCatalogLoadingChange,
      onSourcesLoaded,
      onCatalogLoaded,
      onCatalogFailed: vi.fn(),
    });

    expect(listSources).toHaveBeenCalledTimes(1);
    expect(listModels).toHaveBeenCalledTimes(1);
    resolveSources?.({ success: true, data: sources });
    await vi.waitFor(() => expect(onSourcesLoaded).toHaveBeenCalledWith(sources));
    expect(onSourcesLoadingChange).toHaveBeenLastCalledWith(false);
    expect(onCatalogLoadingChange).not.toHaveBeenCalledWith(false);
    expect(onCatalogLoaded).not.toHaveBeenCalled();

    resolveCatalog?.({ success: true, data: { catalog, source: 'local_discovery', diagnostics: [] } });
    await vi.waitFor(() => expect(onCatalogLoaded).toHaveBeenCalledTimes(1));
    expect(onCatalogLoadingChange).toHaveBeenLastCalledWith(false);
    cancel();
  });
});

describe('model popover dismissal', () => {
  it('keeps inside clicks open and dismisses a canvas click', () => {
    const trigger = document.createElement('button');
    const triggerChild = document.createElement('span');
    trigger.appendChild(triggerChild);
    const menu = document.createElement('div');
    const menuChild = document.createElement('button');
    menu.appendChild(menuChild);
    const canvas = document.createElement('main');

    expect(shouldDismissModelSwitcher(triggerChild, trigger, menu)).toBe(false);
    expect(shouldDismissModelSwitcher(menuChild, trigger, menu)).toBe(false);
    expect(shouldDismissModelSwitcher(canvas, trigger, menu)).toBe(true);
  });
});

describe('engine search helper', () => {
  it('matches label, id, and summary without changing manifest order', () => {
    expect(filterEngineSources(sources, 'buddy').map((source) => source.manifestId)).toEqual(['codebuddy_code']);
    expect(filterEngineSources(sources, 'qoder').map((source) => source.manifestId)).toEqual(['qoder_work']);
    expect(filterEngineSources(sources, 'grok').map((source) => source.manifestId)).toEqual(['grok_cli']);
    expect(filterEngineSources(sources, '').map((source) => source.manifestId)).toEqual(
      sources.map((source) => source.manifestId),
    );
  });
});

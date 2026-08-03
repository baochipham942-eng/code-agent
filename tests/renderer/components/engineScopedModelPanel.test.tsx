// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEngineModelCatalog,
  AgentEngineSourceDescriptor,
} from '../../../src/shared/contract/agentEngine';
import {
  EngineScopedModelPanel,
  filterEngineSources,
} from '../../../src/renderer/components/StatusBar/EngineScopedModelPanel';
import { shouldDismissModelSwitcher } from '../../../src/renderer/components/StatusBar/ModelSwitcher';

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
      />,
    );

    expect(document.querySelectorAll('[data-external-model]')).toHaveLength(2);
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
      />,
    );

    expect(screen.getByText('由官方客户端选择默认模型')).toBeTruthy();
    const slot = document.querySelector('[data-engine-icon-slot]');
    expect(slot?.className).toContain('h-8');
    expect(slot?.className).toContain('w-8');
    expect(slot?.querySelector('svg')?.getAttribute('class')).toContain('h-8');
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
      />,
    );

    expect(document.querySelector('[data-current-external-model]')?.textContent)
      .toContain('Grok 4.5 · grok-4.5');
    expect(document.querySelectorAll('[data-external-model]')).toHaveLength(1);
    fireEvent.click(screen.getByText('Grok 4.5'));
    expect(onSelectExternalModel).toHaveBeenCalledWith('grok_cli', 'grok-4.5');
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

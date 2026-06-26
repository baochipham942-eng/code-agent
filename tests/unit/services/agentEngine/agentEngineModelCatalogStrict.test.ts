import { describe, expect, it } from 'vitest';
import type { AgentEngineModelCatalog } from '../../../../src/shared/contract/agentEngine';
import {
  resolveAgentEngineCatalogModel,
  AgentEngineModelIncompatibleError,
} from '../../../../src/host/services/agentEngine/agentEngineModelCatalog';

const CATALOG: AgentEngineModelCatalog = {
  version: 'test',
  updatedAt: '2026-01-01T00:00:00.000Z',
  engines: [
    {
      kind: 'codex_cli',
      defaultModel: 'gpt-5.3-codex',
      models: [
        { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', capabilities: [] },
        { id: 'gpt-5.5', label: 'GPT-5.5', capabilities: [] },
        { id: 'gpt-old', label: 'Old', capabilities: [], disabledReason: '已停用' },
      ],
    },
  ],
};

describe('resolveAgentEngineCatalogModel — fail-closed (strict)', () => {
  it('非 strict：请求了不兼容模型 → 静默回落引擎默认模型（保留原行为）', () => {
    const resolved = resolveAgentEngineCatalogModel(CATALOG, 'codex_cli', 'claude-opus-4-8');
    expect(resolved?.id).toBe('gpt-5.3-codex');
  });

  it('strict：请求了该引擎下不存在的模型 → 抛 AgentEngineModelIncompatibleError', () => {
    expect(() =>
      resolveAgentEngineCatalogModel(CATALOG, 'codex_cli', 'claude-opus-4-8', { strict: true }),
    ).toThrow(AgentEngineModelIncompatibleError);
  });

  it('strict：请求了已停用模型 → 同样 fail-closed 抛错，不静默换默认', () => {
    expect(() =>
      resolveAgentEngineCatalogModel(CATALOG, 'codex_cli', 'gpt-old', { strict: true }),
    ).toThrow(AgentEngineModelIncompatibleError);
  });

  it('strict：请求了合法模型 → 正常返回该模型', () => {
    const resolved = resolveAgentEngineCatalogModel(CATALOG, 'codex_cli', 'gpt-5.5', { strict: true });
    expect(resolved?.id).toBe('gpt-5.5');
  });

  it('strict：未显式请求模型（空）→ 回落默认模型，不抛错', () => {
    const resolved = resolveAgentEngineCatalogModel(CATALOG, 'codex_cli', undefined, { strict: true });
    expect(resolved?.id).toBe('gpt-5.3-codex');
  });

  it('strict：引擎不存在且请求了模型 → 抛错', () => {
    expect(() =>
      resolveAgentEngineCatalogModel(CATALOG, 'claude_code', 'whatever', { strict: true }),
    ).toThrow(AgentEngineModelIncompatibleError);
  });
});

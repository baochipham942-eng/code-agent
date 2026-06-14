import { describe, expect, it } from 'vitest';
import {
  buildCapabilitySemanticSuggestions,
} from '../../../src/renderer/components/features/chat/ChatInput/CapabilitySuggestionStrip';
import type { WorkbenchCapabilityRegistryItem } from '../../../src/renderer/utils/workbenchCapabilityRegistry';

const lifecycle = {
  installState: 'not_applicable',
  mountState: 'not_applicable',
  connectionState: 'not_applicable',
} as const;

function skill(id: string, description: string): WorkbenchCapabilityRegistryItem {
  return {
    kind: 'skill',
    id,
    key: `skill:${id}`,
    label: id,
    selected: false,
    available: true,
    blocked: false,
    visibleInWorkbench: true,
    health: 'healthy',
    lifecycle,
    mounted: false,
    installState: 'available',
    description,
  };
}

function mcp(id: string): WorkbenchCapabilityRegistryItem {
  return {
    kind: 'mcp',
    id,
    key: `mcp:${id}`,
    label: id,
    selected: false,
    available: true,
    blocked: false,
    visibleInWorkbench: true,
    health: 'healthy',
    lifecycle: {
      installState: 'not_applicable',
      mountState: 'not_applicable',
      connectionState: 'connected',
    },
    status: 'connected',
    enabled: true,
    transport: 'stdio',
    toolCount: 1,
    resourceCount: 0,
  };
}

function connector(id: string, label = id): WorkbenchCapabilityRegistryItem {
  return {
    kind: 'connector',
    id,
    key: `connector:${id}`,
    label,
    selected: false,
    available: true,
    blocked: false,
    visibleInWorkbench: true,
    health: 'healthy',
    lifecycle,
    connected: true,
    capabilities: [],
  };
}

describe('buildCapabilitySemanticSuggestions', () => {
  it('keeps MCP suggestions tied to text matches', () => {
    const suggestions = buildCapabilitySemanticSuggestions('短信 App push 触达率', [
      mcp('code-index'),
      mcp('firecrawl'),
      skill('growth-copy', '短信和 App push 触达分析'),
    ]);

    expect(suggestions.map((item) => item.id)).toEqual(['growth-copy']);
  });

  it('suggests MCP servers for task intent aliases', () => {
    const suggestions = buildCapabilitySemanticSuggestions('查 GitHub PR', [
      mcp('github'),
      skill('growth-copy', '短信和 App push 触达分析'),
    ]);

    expect(suggestions.map((item) => item.kind)).toEqual(['mcp']);
    expect(suggestions.map((item) => item.id)).toEqual(['github']);
  });

  it('suggests connectors from Chinese intent aliases', () => {
    const suggestions = buildCapabilitySemanticSuggestions('看一下今天日历', [
      connector('calendar', 'Calendar'),
      connector('mail', 'Mail'),
    ]);

    expect(suggestions.map((item) => item.kind)).toEqual(['connector']);
    expect(suggestions.map((item) => item.id)).toEqual(['calendar']);
  });

  it('requires a text match instead of suggesting every available capability', () => {
    const suggestions = buildCapabilitySemanticSuggestions('短信 App push 触达率', [
      skill('deck-maker', '生成演示文稿'),
      skill('growth-copy', '短信触达和 push 运营分析'),
    ]);

    expect(suggestions.map((item) => item.id)).toEqual(['growth-copy']);
  });
});

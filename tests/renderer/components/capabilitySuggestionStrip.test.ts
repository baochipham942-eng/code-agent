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

describe('buildCapabilitySemanticSuggestions', () => {
  it('does not show MCP servers in the composer suggestion strip', () => {
    const suggestions = buildCapabilitySemanticSuggestions('短信 App push 触达率', [
      mcp('code-index'),
      mcp('firecrawl'),
      skill('growth-copy', '短信和 App push 触达分析'),
    ]);

    expect(suggestions.map((item) => item.kind)).toEqual(['skill']);
    expect(suggestions.map((item) => item.id)).toEqual(['growth-copy']);
  });

  it('requires a text match instead of suggesting every available capability', () => {
    const suggestions = buildCapabilitySemanticSuggestions('短信 App push 触达率', [
      skill('deck-maker', '生成演示文稿'),
      skill('growth-copy', '短信触达和 push 运营分析'),
    ]);

    expect(suggestions.map((item) => item.id)).toEqual(['growth-copy']);
  });
});

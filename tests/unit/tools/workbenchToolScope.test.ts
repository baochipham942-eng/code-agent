import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';
import {
  filterToolDefinitionsByWorkbenchScope,
  isSkillCommandAllowedByWorkbenchScope,
  isToolNameAllowedByWorkbenchScope,
  normalizeWorkbenchToolScope,
} from '../../../src/main/tools/workbenchToolScope';

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
  };
}

describe('workbenchToolScope', () => {
  it('normalizes and deduplicates selected scope ids', () => {
    expect(normalizeWorkbenchToolScope({
      allowedSkillIds: [' review ', 'review', '', 'ship'],
      allowedConnectorIds: [' mail ', 'mail', '', 'calendar'],
      allowedMcpServerIds: [' github ', 'github', ''],
    })).toEqual({
      allowedSkillIds: ['review', 'ship'],
      allowedConnectorIds: ['mail', 'calendar'],
      allowedMcpServerIds: ['github'],
    });
  });

  it('filters MCP-prefixed tool definitions by allowed server ids', () => {
    const tools = [
      makeTool('Read'),
      makeTool('Skill'),
      makeTool('mail'),
      makeTool('calendar_update_event'),
      makeTool('mcp__github__search_code'),
      makeTool('mcp__filesystem__read_file'),
    ];

    expect(filterToolDefinitionsByWorkbenchScope(tools, {
      allowedConnectorIds: ['mail'],
      allowedMcpServerIds: ['github'],
    }).map((tool) => tool.name)).toEqual([
      'Read',
      'Skill',
      'mail',
      'mcp__github__search_code',
    ]);
  });

  it('blocks MCP tools outside the selected server scope but keeps generic tools available', () => {
    expect(isToolNameAllowedByWorkbenchScope('Read', {
      allowedMcpServerIds: ['github'],
    })).toBe(true);
    expect(isToolNameAllowedByWorkbenchScope('Skill', {
      allowedMcpServerIds: ['github'],
    })).toBe(true);
    expect(isToolNameAllowedByWorkbenchScope('mcp__github__search_code', {
      allowedMcpServerIds: ['github'],
    })).toBe(true);
    expect(isToolNameAllowedByWorkbenchScope('mcp__filesystem__read_file', {
      allowedMcpServerIds: ['github'],
    })).toBe(false);
    expect(isToolNameAllowedByWorkbenchScope('mail', {
      allowedConnectorIds: ['mail'],
    })).toBe(true);
    expect(isToolNameAllowedByWorkbenchScope('calendar_update_event', {
      allowedConnectorIds: ['mail'],
    })).toBe(false);
  });

  it('blocks skills outside the selected skill scope', () => {
    expect(isSkillCommandAllowedByWorkbenchScope('review-skill', {
      allowedSkillIds: ['review-skill'],
    })).toBe(true);
    expect(isSkillCommandAllowedByWorkbenchScope('ship-skill', {
      allowedSkillIds: ['review-skill'],
    })).toBe(false);
  });
});

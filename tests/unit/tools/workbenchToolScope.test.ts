import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';
import { tmeetDescriptor } from '../../../src/shared/constants/cliConnectorDescriptors';
import { CONNECTOR_TOOL_NAMES } from '../../../src/shared/contract/workbenchTools';
import {
  filterToolDefinitionsByWorkbenchScope,
  isSkillCommandAllowedByWorkbenchScope,
  isToolCallAllowedByWorkbenchScope,
  isToolNameAllowedByWorkbenchScope,
  normalizeWorkbenchToolScope,
} from '../../../src/host/tools/workbenchToolScope';

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    outputSchema: { type: 'string' },
    inputSchema: { type: 'object', properties: {} },
    requiresPermission: false,
    permissionLevel: 'read',
  };
}

describe('workbenchToolScope', () => {
  it('derives CLI connector tool names from the canonical descriptor', () => {
    expect(CONNECTOR_TOOL_NAMES.tmeet).toBe(tmeetDescriptor.toolNames);
    expect(CONNECTOR_TOOL_NAMES.tmeet).toEqual(['tmeetMeetingList', 'tmeetMeetingCreate', 'tmeetMeetingSearch']);
  });

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
    expect(isToolNameAllowedByWorkbenchScope('tmeetMeetingList', {
      allowedConnectorIds: ['tmeet'],
    })).toBe(true);
    expect(isToolNameAllowedByWorkbenchScope('tmeetMeetingCreate', {
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

  // 元工具（mcp / MCPUnified）把 server 放在参数里，按工具名判不到——dispatch 门要读 args.server，
  // 否则收窄形同虚设：模型 list_tools 找到被收窄的 server 再 invoke，一路畅通（ai-review 第八轮抓的实病）
  describe('isToolCallAllowedByWorkbenchScope（dispatch 门，读参数里的 server）', () => {
    const scope = { allowedMcpServerIds: ['lark'] };

    it('mcp invoke：范围外的 server 挡住，范围内的放行', () => {
      expect(isToolCallAllowedByWorkbenchScope('mcp', { server: 'github', tool: 'search' }, scope)).toBe(false);
      expect(isToolCallAllowedByWorkbenchScope('mcp', { server: 'lark', tool: 'doc' }, scope)).toBe(true);
    });

    it('MCPUnified：invoke / read_resource 按 server 挡，list / status / add_server 不按 server 挡', () => {
      expect(isToolCallAllowedByWorkbenchScope('MCPUnified', { action: 'invoke', server: 'github', tool: 'x' }, scope)).toBe(false);
      expect(isToolCallAllowedByWorkbenchScope('MCPUnified', { action: 'invoke', server: 'lark', tool: 'x' }, scope)).toBe(true);
      expect(isToolCallAllowedByWorkbenchScope('MCPUnified', { action: 'read_resource', server: 'github', uri: 'u' }, scope)).toBe(false);
      expect(isToolCallAllowedByWorkbenchScope('MCPUnified', { action: 'list_tools' }, scope)).toBe(true);
      expect(isToolCallAllowedByWorkbenchScope('MCPUnified', { action: 'list_resources' }, scope)).toBe(true);
      expect(isToolCallAllowedByWorkbenchScope('MCPUnified', { action: 'status' }, scope)).toBe(true);
      expect(isToolCallAllowedByWorkbenchScope('MCPUnified', { action: 'add_server', name: 'github' }, scope)).toBe(true);
    });

    it('收窄生效时要碰 server 数据却报不出 server 名：fail-closed', () => {
      expect(isToolCallAllowedByWorkbenchScope('mcp', { tool: 'x' }, scope)).toBe(false);
      expect(isToolCallAllowedByWorkbenchScope('MCPUnified', { action: 'invoke' }, scope)).toBe(false);
    });

    it('mcp_add_server 不被误解析成 server「add」——管理动作不该被名字里的下划线错挡', () => {
      expect(isToolCallAllowedByWorkbenchScope('mcp_add_server', { name: 'github' }, scope)).toBe(true);
    });

    it('没有 MCP 收窄时元工具不受这道门管', () => {
      expect(isToolCallAllowedByWorkbenchScope('mcp', { server: 'github', tool: 'x' }, { allowedConnectorIds: ['mail'] })).toBe(true);
      expect(isToolCallAllowedByWorkbenchScope('mcp', { server: 'github', tool: 'x' }, undefined)).toBe(true);
    });
  });
});

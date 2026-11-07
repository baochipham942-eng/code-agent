// N-CUA-SCREEN-GUARDS-LADDER：能力阶梯后缀只挂 cua-driver 三个入口工具
// （launch_app / get_window_state / click）和 V2 computer_use 描述，其余
// cua 工具与非 cua server 一律不挂（token 成本约束）。
import { afterEach, describe, expect, it } from 'vitest';
import { MCPToolRegistry } from '../../../src/host/mcp/mcpToolRegistry';
import {
  CUA_SCREEN_LADDER_ENTRY_TOOLS,
  CUA_SCREEN_LADDER_TOOL_SUFFIX,
} from '../../../src/host/mcp/cuaLadderGuidance';
import { cuaStatefulComputerUseSchema } from '../../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse.schema';

const RAW_CUA_TOOLS = [
  'launch_app',
  'get_window_state',
  'click',
  'type_text',
  'press_key',
  'screenshot',
  'start_session',
  'end_session',
];

const LADDER_TOOL_NAMES = [...CUA_SCREEN_LADDER_ENTRY_TOOLS].map(
  (name) => `mcp__cua-driver__${name}`,
);

function buildRegistryWithCuaTools(): MCPToolRegistry {
  const registry = new MCPToolRegistry();
  registry.tools = RAW_CUA_TOOLS.map((name) => ({
    serverName: 'cua-driver',
    name,
    description: `CUA tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
  }));
  return registry;
}

describe('cua screen ladder tool suffix (N-CUA-SCREEN-GUARDS-LADDER)', () => {
  const PREV_V2 = process.env.CODE_AGENT_CUA_STATE_V2;

  afterEach(() => {
    // isRawCuaToolHidden 读 CODE_AGENT_CUA_STATE_V2；保证 raw 工具面可见的前提不被串档。
    if (PREV_V2 === undefined) delete process.env.CODE_AGENT_CUA_STATE_V2;
    else process.env.CODE_AGENT_CUA_STATE_V2 = PREV_V2;
  });

  it('appends the ladder sentence to exactly launch_app / get_window_state / click', () => {
    delete process.env.CODE_AGENT_CUA_STATE_V2;
    const definitions = buildRegistryWithCuaTools().getToolDefinitions();
    expect(definitions).toHaveLength(RAW_CUA_TOOLS.length);

    for (const name of LADDER_TOOL_NAMES) {
      const definition = definitions.find((candidate) => candidate.name === name);
      expect(definition?.description, `${name} 缺阶梯后缀`).toBe(
        `[MCP:cua-driver] CUA tool ${name.replace('mcp__cua-driver__', '')} ${CUA_SCREEN_LADDER_TOOL_SUFFIX}`,
      );
    }

    const others = definitions.filter((candidate) => !LADDER_TOOL_NAMES.includes(candidate.name));
    expect(others.length).toBeGreaterThan(0);
    for (const definition of others) {
      expect(definition.description, `${definition.name} 不该挂后缀`).not.toContain(
        CUA_SCREEN_LADDER_TOOL_SUFFIX,
      );
    }
  });

  it('does not touch same-named tools on non-cua servers', () => {
    const registry = new MCPToolRegistry();
    registry.tools = [
      'launch_app',
      'get_window_state',
      'click',
    ].map((name) => ({
      serverName: 'other-mcp',
      name,
      description: `Unrelated ${name}`,
      inputSchema: { type: 'object', properties: {} },
    }));

    for (const definition of registry.getToolDefinitions()) {
      expect(definition.description, `${definition.name} 不该挂后缀`).not.toContain(
        CUA_SCREEN_LADDER_TOOL_SUFFIX,
      );
    }
  });

  it('V2 computer_use description carries the same ladder sentence', () => {
    expect(cuaStatefulComputerUseSchema.description).toContain(CUA_SCREEN_LADDER_TOOL_SUFFIX);
  });
});

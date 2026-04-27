import { beforeEach, describe, expect, it } from 'vitest';
import { agentSpawnTool, sdkTaskTool, sendInputTool, spawnAgentTool } from '../../../src/main/agent/multiagentTools';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/main/tools/protocolRegistry';

describe('multiagent protocol schemas', () => {
  beforeEach(() => {
    resetProtocolRegistry();
  });

  it('uses the real Task schema for the protocol wrapper', () => {
    const schema = getProtocolRegistry().getSchemas().find((toolSchema) => toolSchema.name === 'Task');

    expect(schema?.inputSchema).toEqual(sdkTaskTool.inputSchema);
    expect(schema?.inputSchema.required).toEqual(['prompt', 'subagent_type']);
  });

  it('uses the real spawn_agent schema for the protocol wrapper', () => {
    const schema = getProtocolRegistry().getSchemas().find((toolSchema) => toolSchema.name === 'spawn_agent');

    expect(schema?.inputSchema).toEqual(spawnAgentTool.inputSchema);
    expect(schema?.inputSchema.properties).toHaveProperty('role');
    expect(schema?.inputSchema.properties).toHaveProperty('task');
    expect(schema?.inputSchema.properties).toHaveProperty('agents');
  });

  it('uses the real AgentSpawn schema for the protocol wrapper', () => {
    const schema = getProtocolRegistry().getSchemas().find((toolSchema) => toolSchema.name === 'AgentSpawn');

    expect(schema?.inputSchema).toEqual(agentSpawnTool.inputSchema);
    expect(schema?.inputSchema.properties).toHaveProperty('role');
    expect(schema?.inputSchema.properties).toHaveProperty('task');
    expect(schema?.inputSchema.properties).toHaveProperty('agents');
  });

  it('does not advertise unsupported send_input interrupt control', () => {
    const schema = getProtocolRegistry().getSchemas().find((toolSchema) => toolSchema.name === 'send_input');

    expect(schema?.inputSchema).toEqual(sendInputTool.inputSchema);
    expect(sendInputTool.inputSchema.properties).toHaveProperty('agentId');
    expect(sendInputTool.inputSchema.properties).toHaveProperty('message');
    expect(sendInputTool.inputSchema.properties).not.toHaveProperty('interrupt');
    expect(schema?.inputSchema.properties).not.toHaveProperty('agent_id');
    expect(schema?.inputSchema.properties).not.toHaveProperty('input');
    expect(sendInputTool.description).not.toMatch(/interrupt=true/);
  });
});

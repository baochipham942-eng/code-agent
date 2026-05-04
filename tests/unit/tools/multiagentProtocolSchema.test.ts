import { beforeEach, describe, expect, it } from 'vitest';
import { exploreTool } from '../../../src/main/agent/multiagentTools';
import { taskSchema } from '../../../src/main/tools/modules/multiagent/task.schema';
import { sendInputSchema } from '../../../src/main/tools/modules/multiagent/sendInput.schema';
import { spawnAgentSchema, agentSpawnSchema } from '../../../src/main/tools/modules/multiagent/spawnAgent.schema';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/main/tools/protocolRegistry';

describe('multiagent protocol schemas', () => {
  beforeEach(() => {
    resetProtocolRegistry();
  });

  it('uses the real Task schema for the protocol wrapper', () => {
    const schema = getProtocolRegistry().getSchemas().find((toolSchema) => toolSchema.name === 'Task');

    expect(schema?.inputSchema).toEqual(taskSchema.inputSchema);
    expect(schema?.inputSchema.required).toEqual(['prompt', 'subagent_type']);
  });

  it('uses the real Explore schema for the protocol wrapper', () => {
    const schema = getProtocolRegistry().getSchemas().find((toolSchema) => toolSchema.name === 'Explore');

    expect(schema?.inputSchema).toEqual(exploreTool.inputSchema);
    expect(schema?.inputSchema.required).toEqual(['prompt']);
  });

  it('uses the real spawn_agent schema for the protocol wrapper', () => {
    const schema = getProtocolRegistry().getSchemas().find((toolSchema) => toolSchema.name === 'spawn_agent');

    expect(schema?.inputSchema).toEqual(spawnAgentSchema.inputSchema);
    expect(schema?.inputSchema.properties).toHaveProperty('role');
    expect(schema?.inputSchema.properties).toHaveProperty('task');
    expect(schema?.inputSchema.properties).toHaveProperty('agents');
  });

  it('uses the real AgentSpawn schema for the protocol wrapper', () => {
    const schema = getProtocolRegistry().getSchemas().find((toolSchema) => toolSchema.name === 'AgentSpawn');

    expect(schema?.inputSchema).toEqual(agentSpawnSchema.inputSchema);
    expect(schema?.inputSchema.properties).toHaveProperty('role');
    expect(schema?.inputSchema.properties).toHaveProperty('task');
    expect(schema?.inputSchema.properties).toHaveProperty('agents');
  });

  it('does not advertise unsupported send_input interrupt control', () => {
    const schema = getProtocolRegistry().getSchemas().find((toolSchema) => toolSchema.name === 'send_input');

    expect(schema?.inputSchema).toEqual(sendInputSchema.inputSchema);
    expect(sendInputSchema.inputSchema.properties).toHaveProperty('agentId');
    expect(sendInputSchema.inputSchema.properties).toHaveProperty('message');
    expect(sendInputSchema.inputSchema.properties).not.toHaveProperty('interrupt');
    expect(schema?.inputSchema.properties).not.toHaveProperty('agent_id');
    expect(schema?.inputSchema.properties).not.toHaveProperty('input');
    expect(sendInputSchema.description).not.toMatch(/interrupt=true/);
  });
});

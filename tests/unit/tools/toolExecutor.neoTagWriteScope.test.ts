import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => {
  const getDefinition = vi.fn();
  const execute = vi.fn();
  return { getDefinition, execute };
});

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { NeoTagRunContext } from '../../../src/shared/contract/tag';

const neoTag = {
  workCardId: 'nwc_1',
  projectId: 'proj_1',
  sourceConversationId: 'conv_1',
  sourceTurnId: 'msg_1',
  approvedRevisionId: 'rev_1',
  runId: 'neorun_1',
  contextPackId: 'ctx_1',
  modelIntent: { mode: 'inherit_current' },
  contextPack: {
    id: 'ctx_1',
    projectId: 'proj_1',
    workCardId: 'nwc_1',
    workCardRevisionId: 'rev_1',
    seedConversationId: 'conv_1',
    seedTurnId: 'msg_1',
    strategy: 'plain',
    selectedMessages: [],
    selectedArtifacts: [],
    selectedMemoryEntryIds: [],
    selectedFiles: [],
    excluded: [],
    expandableScopes: [],
    budget: { maxTokens: 1, estimatedTokens: 1 },
    createdAt: 1,
  },
} as NeoTagRunContext;

function definition(name: string) {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: false,
    permissionLevel: 'execute',
  };
}

async function runTool(toolName: string, params: Record<string, unknown>) {
  resolverState.getDefinition.mockReturnValue(definition(toolName));
  const executor = new ToolExecutor({
    requestPermission: async () => true,
    workingDirectory: '/tmp/workbench',
  });
  return executor.execute(toolName, params, {
    sessionId: 'session_1',
    neoTag,
  });
}

describe('ToolExecutor Neo Tag safety guard', () => {
  beforeEach(() => {
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, output: 'ok' });
  });

  it.each([
    ['git_commit', { action: 'add', files: ['src/a.ts'] }],
    ['git_commit', { action: 'commit', message: 'save' }],
    ['git_commit', { action: 'push', remote: 'origin' }],
    ['git_worktree', { action: 'add', path: '../x' }],
    ['git_worktree', { action: 'remove', path: '../x' }],
    ['git_worktree', { action: 'prune' }],
    ['kill_shell', { task_id: 'shell_1' }],
    ['AgentSpawn', { action: 'spawn', prompt: 'review' }],
    ['WorkflowOrchestrate', { action: 'run' }],
    ['Teammate', { action: 'send', message: 'go' }],
    ['TaskManager', { action: 'patch' }],
    ['Plan', { action: 'update' }],
    ['PlanMode', { action: 'enter' }],
    ['findings_write', { title: 'finding' }],
    ['MemoryWrite', { action: 'write', filename: 'x.md', content: 'x' }],
    ['MemoryWrite', { action: 'delete', filename: 'x.md' }],
    ['SkillCreate', { name: 'new-skill' }],
    ['propose_role', { name: 'new role' }],
    ['reminders_delete', { action: 'delete', id: 'r1' }],
    ['mail_send', { action: 'send', to: 'a@example.com' }],
    ['calendar_create_event', { action: 'create', title: 'meet' }],
    ['MCPUnified', { action: 'add_server', name: 'jira' }],
    ['MCPUnified', { action: 'invoke', server: 'jira', tool: 'create_issue' }],
    ['mcp_add_server', { name: 'jira' }],
    ['mcp__jira__create_issue', { summary: 'bug' }],
    ['Process', { action: 'submit', id: 'p1', input: 'yes' }],
    ['Process', { action: 'write', id: 'p1', input: 'yes' }],
    ['Process', { action: 'kill', id: 'p1' }],
    ['process_submit', { id: 'p1', input: 'yes' }],
    ['process_write', { id: 'p1', input: 'yes' }],
    ['process_kill', { id: 'p1' }],
  ])('blocks Neo Tag external state mutation via %s', async (toolName, params) => {
    const result = await runTool(toolName, params);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Neo Tag safety guard blocked');
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['git_commit', { action: 'status' }],
    ['git_commit', { action: 'log', limit: 3 }],
    ['git_commit', { action: 'diff' }],
    ['git_worktree', { action: 'list' }],
    ['AgentSpawn', { action: 'status' }],
    ['WorkflowOrchestrate', { action: 'result' }],
    ['Teammate', { action: 'inbox' }],
    ['TaskManager', { action: 'list' }],
    ['TaskGet', { id: 't1' }],
    ['TaskList', {}],
    ['Plan', { action: 'read' }],
    ['plan_read', {}],
    ['MemoryRead', { filename: 'x.md' }],
    ['reminders', { action: 'list' }],
    ['mail_search', { action: 'search', query: 'from:a' }],
    ['calendar_list_events', { action: 'list' }],
    ['MCPUnified', { action: 'status' }],
    ['MCPUnified', { action: 'list_tools' }],
    ['MCPUnified', { action: 'list_resources' }],
    ['MCPUnified', { action: 'read_resource', uri: 'file:///x' }],
    ['mcp_read_resource', { uri: 'file:///x' }],
    ['mcp__jira__search_issues', { query: 'status=open' }],
    ['Process', { action: 'list' }],
    ['Process', { action: 'poll', id: 'p1' }],
    ['Process', { action: 'log', id: 'p1' }],
    ['process_list', {}],
    ['process_log', { id: 'p1' }],
  ])('allows Neo Tag read-only observation via %s', async (toolName, params) => {
    const result = await runTool(toolName, params);

    expect(result.success).toBe(true);
    expect(resolverState.execute).toHaveBeenCalledWith(
      toolName,
      params,
      expect.objectContaining({
        neoTag,
        sessionId: 'session_1',
      }),
    );
  });

  it('does not apply the Neo Tag guard to ordinary non-Neo tool calls', async () => {
    resolverState.getDefinition.mockReturnValue(definition('MemoryWrite'));
    const executor = new ToolExecutor({
      requestPermission: async () => true,
      workingDirectory: '/tmp/workbench',
    });

    const result = await executor.execute('MemoryWrite', { action: 'write', filename: 'x.md', content: 'x' }, {
      sessionId: 'session_1',
    });

    expect(result.success).toBe(true);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });
});

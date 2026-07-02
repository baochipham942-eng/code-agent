// ============================================================================
// Neo Tag Tool Guard - approved Neo run 的 fail-closed 工具边界（ADR-031）
// ============================================================================
// 从 toolExecutor.ts 平移抽出（纯代码搬移，无行为变更）。
// ToolExecutor 在 options.neoTag 存在时对每次工具调用先过这道闸。

export function commandMatchesScopedPrefix(command: string, prefix: string): boolean {
  const trimmedCommand = command.trimStart();
  return trimmedCommand === prefix
    || trimmedCommand.startsWith(`${prefix} `)
    || trimmedCommand.startsWith(`${prefix}\t`);
}

export type NeoTagToolGuardDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function startsWithAny(value: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function isReadOnlyAction(action: string): boolean {
  return [
    'collect',
    'diff',
    'fetch',
    'find',
    'get',
    'history',
    'inbox',
    'list',
    'list_resources',
    'list_tools',
    'log',
    'poll',
    'query',
    'read',
    'read_resource',
    'result',
    'search',
    'show',
    'status',
    'wait',
  ].includes(action);
}

function isMutationAction(action: string): boolean {
  return [
    'add',
    'add_server',
    'archive',
    'cancel',
    'commit',
    'create',
    'delete',
    'enter',
    'exit',
    'forget',
    'invoke',
    'kill',
    'patch',
    'post',
    'prune',
    'push',
    'put',
    'recover',
    'remove',
    'replace',
    'run',
    'send',
    'spawn',
    'start',
    'submit',
    'update',
    'write',
  ].includes(action);
}

function blockNeoTagMutation(toolName: string, reason: string): NeoTagToolGuardDecision {
  return {
    allowed: false,
    reason: `Neo Tag safety guard blocked ${toolName}: ${reason}`,
  };
}

export function checkNeoTagToolGuard(
  toolName: string,
  params: Record<string, unknown>,
): NeoTagToolGuardDecision {
  const lowerTool = toolName.toLowerCase();
  const action = stringParam(params, 'action');
  const operation = stringParam(params, 'operation');
  const verb = action || operation;

  if (lowerTool === 'git_commit') {
    if (['status', 'log', 'diff'].includes(verb)) return { allowed: true };
    if (['add', 'commit', 'push'].includes(verb) || !verb) {
      return blockNeoTagMutation(toolName, `git_commit ${verb || 'unknown'} mutates git state outside the approved work-card file scope`);
    }
  }

  if (lowerTool === 'git_worktree') {
    if (['list', 'status'].includes(verb)) return { allowed: true };
    if (['add', 'remove', 'prune'].includes(verb) || !verb) {
      return blockNeoTagMutation(toolName, `git_worktree ${verb || 'unknown'} mutates local worktree state outside the approved work card`);
    }
  }

  if (lowerTool === 'kill_shell') {
    return blockNeoTagMutation(toolName, 'terminating background shells is an external process-state mutation');
  }

  if (['process_submit', 'process_write', 'process_kill'].includes(lowerTool)) {
    return blockNeoTagMutation(toolName, 'interactive process submit/write/kill can mutate process state outside result review');
  }

  if (lowerTool === 'process') {
    if (['list', 'status', 'poll', 'log', 'read'].includes(verb)) return { allowed: true };
    if (['submit', 'write', 'kill'].includes(verb) || !verb) {
      return blockNeoTagMutation(toolName, `Process ${verb || 'unknown'} can mutate interactive process state`);
    }
  }

  if (['memorywrite', 'memory_write'].includes(lowerTool)) {
    return blockNeoTagMutation(toolName, 'Neo Tag memory writes must stay as explicit memory candidates until user review');
  }

  if (['memoryread', 'memory_read'].includes(lowerTool)) {
    return { allowed: true };
  }

  if (['skillcreate', 'skill_create', 'create_skill', 'propose_role', 'tool_create'].includes(lowerTool)) {
    return blockNeoTagMutation(toolName, 'creating reusable skills or roles is outside the approved work-card write scope');
  }

  if (['plan_update', 'findings_write', 'taskcreate', 'task_create', 'taskupdate', 'task_update', 'plan_recover_recent_work'].includes(lowerTool)) {
    return blockNeoTagMutation(toolName, 'planning, findings, and task mutations must not be driven by an approved Neo runtime run');
  }

  if (['plan_read', 'taskget', 'task_get', 'tasklist', 'task_list'].includes(lowerTool)) {
    return { allowed: true };
  }

  if (['planmode', 'enter_plan_mode', 'exit_plan_mode'].includes(lowerTool)) {
    return blockNeoTagMutation(toolName, 'plan mode changes mutate the surrounding session state');
  }

  if (lowerTool === 'plan') {
    if (isReadOnlyAction(verb)) return { allowed: true };
    if (isMutationAction(verb) || !verb) {
      return blockNeoTagMutation(toolName, `Plan ${verb || 'unknown'} mutates planning state`);
    }
  }

  if (lowerTool === 'taskmanager') {
    if (isReadOnlyAction(verb)) return { allowed: true };
    if (isMutationAction(verb) || !verb) {
      return blockNeoTagMutation(toolName, `TaskManager ${verb || 'unknown'} mutates task state`);
    }
  }

  if (['agentspawn', 'agent_spawn', 'workflow', 'dynamicworkflow', 'dynamic_workflow', 'workflow_orchestrate', 'workfloworchestrate', 'teammate', 'agentmessage', 'agent_message'].includes(lowerTool)) {
    if (isReadOnlyAction(verb)) return { allowed: true };
    if (isMutationAction(verb) || !verb) {
      return blockNeoTagMutation(toolName, `${verb || 'unknown'} can spawn, drive, or mutate other agents/workflows`);
    }
  }

  if (lowerTool === 'mcpunified' || lowerTool === 'mcp') {
    if (['status', 'list_tools', 'list_resources', 'read_resource'].includes(verb)) return { allowed: true };
    if (['add_server', 'invoke'].includes(verb) || !verb) {
      return blockNeoTagMutation(toolName, `MCP ${verb || 'unknown'} is fail-closed until server tool capabilities are classified`);
    }
  }

  if (['mcp_add_server'].includes(lowerTool)) {
    return blockNeoTagMutation(toolName, 'adding MCP servers mutates local connector configuration');
  }

  if (['mcp_read_resource', 'mcp_list_resources', 'mcp_list_tools', 'mcp_get_status'].includes(lowerTool)) {
    return { allowed: true };
  }

  if (startsWithAny(lowerTool, ['mcp__'])) {
    const lastSegment = lowerTool.split('__').at(-1) ?? lowerTool;
    if (/^(read|get|list|search|query|fetch|find|show|describe)/.test(lastSegment)) return { allowed: true };
    return blockNeoTagMutation(toolName, 'direct MCP tool invocation is fail-closed for approved Neo runtime runs');
  }

  if (includesAny(lowerTool, ['calendar', 'reminder', 'mail'])) {
    if (isReadOnlyAction(verb)) return { allowed: true };
    if (
      isMutationAction(verb)
      || includesAny(lowerTool, ['create', 'update', 'delete', 'send', 'post', 'patch', 'write'])
    ) {
      return blockNeoTagMutation(toolName, 'calendar/reminder/mail connector writes affect external state');
    }
  }

  return { allowed: true };
}

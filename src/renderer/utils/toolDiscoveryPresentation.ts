import type { ToolCapabilityView } from '../types/runWorkbench';

export type ToolDiscoveryGroupKey =
  | 'callable'
  | 'needsAuthorization'
  | 'blocked'
  | 'activatedForTurn';

export interface ToolDiscoveryGroup {
  key: ToolDiscoveryGroupKey;
  label: string;
  tools: ToolCapabilityView[];
}

function needsAuthorization(tool: ToolCapabilityView): boolean {
  const reason = tool.blockedReason?.toLowerCase() || '';
  return reason.includes('permission')
    || reason.includes('auth')
    || reason.includes('approval')
    || reason.includes('授权')
    || reason.includes('审批')
    || reason.includes('未登录');
}

export function buildToolDiscoveryGroups(tools: ToolCapabilityView[]): ToolDiscoveryGroup[] {
  const callable = tools.filter((tool) => tool.callable);
  const needsAuth = tools.filter((tool) => !tool.callable && needsAuthorization(tool));
  const blocked = tools.filter((tool) => !tool.callable && !needsAuthorization(tool));
  const activatedForTurn = tools.filter((tool) => tool.activatedForTurn);

  return [
    { key: 'callable', label: '可调用', tools: callable },
    { key: 'needsAuthorization', label: '需要授权', tools: needsAuth },
    { key: 'blocked', label: '不可调用', tools: blocked },
    { key: 'activatedForTurn', label: '本轮临时启用', tools: activatedForTurn },
  ];
}

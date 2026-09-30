// ============================================================================
// 成员执行引擎侧表（N-MEMBER-INPUT-DROP）
// ----------------------------------------------------------------------------
// 外部引擎执行器不读收件箱。补话要么在入队前拒收，要么别进队列。
// 引擎不写进 SpawnGuard：那份档案已经贴着行数上限。native 不占表项。
// ============================================================================

import type { AgentEngineKind } from '../../shared/contract/agentEngine';
import { AGENT_ENGINE_LABELS } from '../../shared/contract/agentEngine';
import type { MemberFollowUpFailure } from '../../shared/contract/memberInput';

const enginesByMember = new Map<string, AgentEngineKind>();

/** native 删除表项，避免每个子代理都留一条；外部引擎留下，供补话入口拒收。 */
export function rememberMemberEngine(agentId: string, engine: AgentEngineKind): void {
  if (engine === 'native') {
    enginesByMember.delete(agentId);
    return;
  }
  enginesByMember.set(agentId, engine);
}

/**
 * 记忆优先，其次调用方已经解析好的引擎（含它问过的角色注册表）。
 * 本模块不直接加载角色注册表，避免把配置服务拉进补话 IPC 的导入图。
 */
export function resolveMemberEngine(input: {
  agentId: string;
  engine?: AgentEngineKind;
}): AgentEngineKind {
  const remembered = enginesByMember.get(input.agentId);
  if (remembered) return remembered;
  if (input.engine) return input.engine;
  return 'native';
}

export function externalEngineFollowUpFailure(engine: AgentEngineKind): MemberFollowUpFailure | null {
  if (engine === 'native') return null;
  const engineLabel = AGENT_ENGINE_LABELS[engine];
  return {
    code: 'external_engine',
    engineLabel,
    message: `This member is run by ${engineLabel}; it can't take new input while running. Ask again after it finishes.`,
  };
}

export function undeliveredFollowUpFailure(count: number): MemberFollowUpFailure | null {
  if (count <= 0) return null;
  return {
    code: 'undelivered_pending',
    undeliveredCount: count,
    message: `${count} follow-up message(s) were never delivered`,
  };
}

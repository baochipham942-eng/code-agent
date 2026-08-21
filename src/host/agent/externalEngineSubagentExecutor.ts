import { AgentEngineCapabilityError } from '../../shared/contract/agentEngine';
import type {
  AgentEnginePermissionProfile,
  ExternalAgentEngineKind,
} from '../../shared/contract/agentEngine';
import { AGENT_ENGINE_LABELS } from '../../shared/contract/agentEngine';
import { normalizeCancellationReason } from '../../shared/contract/cancellation';
import { getExternalEngineManifestForKind } from '../../shared/externalEngineManifest';
import { createLogger } from '../services/infra/logger';
import {
  assertAgentEngineManifestCapability,
  assertExternalSubagentProfile,
} from '../services/agentEngine/agentEngineGuards';
import { getExternalEngineAdapter } from '../services/agentEngine/agentEngineAdapterRegistry';
import { isAgentWorktreePath } from './agentWorktreePath';
import { getSubagentModelOverride } from './agentDefinition';
import type { SubagentExecutorPort } from './subagentExecutorPort';
import type { SubagentExecutionRequest, SubagentResult } from './subagentExecutorTypes';

const logger = createLogger('ExternalEngineSubagentExecutor');

export class ExternalEngineSubagentExecutor implements SubagentExecutorPort {
  async execute(request: SubagentExecutionRequest): Promise<SubagentResult> {
    const engine = request.config.engine;
    const agentId = request.context.executionAgentId ?? request.context.agentId;
    if (!engine || engine === 'native') {
      return failedResult('外部子代理执行器收到 native 引擎，已拒绝错误路由。', agentId);
    }

    try {
      assertAgentEngineManifestCapability(engine, 'execute');
      const permissionProfile = resolveSubagentPermissionProfile(engine, request.context.cwd);
      const model = request.config.roleId
        ? getSubagentModelOverride(request.config.roleId)
        : undefined;
      logger.info('external subagent engine selected', {
        engine,
        profile: permissionProfile,
        cwd: request.context.cwd,
        agentId,
      });

      const result = await getExternalEngineAdapter(engine).run({
        sessionId: request.context.sessionId,
        prompt: request.prompt,
        cwd: request.context.cwd,
        workspaceRoot: request.context.cwd,
        model,
        permissionProfile,
        executionOrigin: 'subagent',
        abortSignal: request.context.abortSignal,
        emitEvent: (event) => {
          logger.debug('external subagent event', { engine, agentId, type: event.type });
        },
      });

      const cancelled = request.context.abortSignal.aborted || result.status === 'cancelled';
      return {
        success: result.status === 'completed',
        output: result.outputText ?? '',
        ...(result.status === 'completed'
          ? {}
          : { error: humanizeExternalFailure(engine, result.failure?.suggestion, cancelled) }),
        toolsUsed: [],
        iterations: 1,
        ...(agentId ? { agentId } : {}),
        ...(cancelled
          ? { cancellationReason: normalizeCancellationReason(request.context.abortSignal.reason, 'parent-cancel') }
          : {}),
      };
    } catch (error) {
      return failedResult(humanizeCaughtError(engine, error), agentId);
    }
  }
}

function resolveSubagentPermissionProfile(
  engine: ExternalAgentEngineKind,
  cwd: string,
): AgentEnginePermissionProfile {
  if (!isAgentWorktreePath(cwd)) return 'read_only';
  assertAgentEngineManifestCapability(engine, 'workspace_write');
  return assertExternalSubagentProfile('workspace_write', { origin: 'subagent', cwd });
}

function humanizeExternalFailure(
  engine: ExternalAgentEngineKind,
  suggestion: string | undefined,
  cancelled: boolean,
): string {
  if (cancelled) return `${AGENT_ENGINE_LABELS[engine]} 子代理已停止。`;
  return suggestion?.trim()
    ? `${AGENT_ENGINE_LABELS[engine]} 子代理执行失败：${suggestion.trim()}`
    : `${AGENT_ENGINE_LABELS[engine]} 子代理未能完成执行，请检查 CLI 安装、登录状态和非交互权限配置。`;
}

function humanizeCaughtError(engine: ExternalAgentEngineKind, error: unknown): string {
  if (error instanceof AgentEngineCapabilityError) {
    if (error.capability === 'workspace_write') {
      return `${AGENT_ENGINE_LABELS[engine]} 未声明 worktree 写入能力，已拒绝执行。`;
    }
    return `${AGENT_ENGINE_LABELS[engine]} 当前不支持子代理执行，已拒绝运行。`;
  }
  const manifest = getExternalEngineManifestForKind(engine);
  return `${manifest?.label ?? engine} 子代理启动失败，请检查 CLI 是否已安装并完成登录。`;
}

function failedResult(error: string, agentId: string | undefined): SubagentResult {
  return {
    success: false,
    output: '',
    error,
    toolsUsed: [],
    iterations: 1,
    ...(agentId ? { agentId } : {}),
  };
}

let externalEngineSubagentExecutor: ExternalEngineSubagentExecutor | null = null;

export function getExternalEngineSubagentExecutor(): ExternalEngineSubagentExecutor {
  externalEngineSubagentExecutor ??= new ExternalEngineSubagentExecutor();
  return externalEngineSubagentExecutor;
}

import { DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../shared/constants';
import type { CronJobAction, CronJobDefinition } from '../../shared/contract/cron';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
import { readCronSourceSessionId } from './cronAutomationBridge';
import { formatCronAgentSessionTitle, getCronAgentSessionType } from './cronNormalizers';
import { cronAgentWorkingDirectory } from './artifactStandingRefresh';
import { siteOriginFromUrl } from '../../shared/utils/browserLoginWall';

function cronLoginGatedSiteOrigin(definition: CronJobDefinition): string | undefined {
  // Only the explicit renderer consent action writes this field. The
  // loginGatedSiteOrigin candidate used for create/edit warnings is not a
  // pass-through grant and must never reach unattended browser sessions.
  const candidate = definition.metadata?.loginPassThroughOrigin;
  if (typeof candidate !== 'string' || !candidate.trim()) return undefined;
  const normalized = siteOriginFromUrl(candidate.trim());
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create the dedicated agent session for a cron run. Resolution order:
 * settings 默认模型 → 来源会话模型 → 全局默认；工作目录沿用来源/当前会话。
 * The session is created read-only; memory off is inherited from the source session.
 */
export async function createCronAgentSession(
  definition: CronJobDefinition,
  action: CronJobAction,
  executionId?: string
) {
  const { getConfigService, getSessionManager } = await import('../services');

  const configService = getConfigService();
  const sessionManager = getSessionManager();
  const currentSessionId = sessionManager.getCurrentSessionId();
  const sourceSessionId = readCronSourceSessionId(definition, action);
  const sourceSession = sourceSessionId
    ? await sessionManager.getSession(sourceSessionId).catch(() => null)
    : null;
  const currentSession = currentSessionId
    ? await sessionManager.getSession(currentSessionId)
    : null;
  const baseSession = sourceSession ?? currentSession;
  const settings = configService.getSettings();
  const sessionType = getCronAgentSessionType(action);
  const originKind = sessionType === 'heartbeat' ? 'heartbeat' : 'cron';
  const loginGatedSiteOrigin = cronLoginGatedSiteOrigin(definition);

  return sessionManager.createSession({
    title: formatCronAgentSessionTitle(definition, sessionType),
    modelConfig: resolveSessionDefaultModelConfig({
      provider: settings.model?.provider || baseSession?.modelConfig.provider || DEFAULT_PROVIDER,
      model: settings.model?.model || baseSession?.modelConfig.model || DEFAULT_MODELS.chat,
      temperature: settings.model?.temperature ?? baseSession?.modelConfig.temperature ?? 0.7,
      maxTokens: settings.model?.maxTokens ?? baseSession?.modelConfig.maxTokens,
    }),
    workingDirectory: cronAgentWorkingDirectory(definition, baseSession?.workingDirectory),
    type: sessionType,
    origin: {
      kind: originKind,
      id: definition.id,
      name: definition.name,
      metadata: {
        scheduleType: definition.scheduleType,
        actionType: action.type,
        sourceSessionId,
        ...(loginGatedSiteOrigin ? { loginPassThroughOrigin: loginGatedSiteOrigin } : {}),
      },
    },
    parentSessionId: sourceSessionId,
    sourceRunId: executionId,
    readOnly: true, memoryMode: sourceSession?.memoryMode === 'off' ? 'off' : undefined,
  });
}

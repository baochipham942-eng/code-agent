import { Router } from 'express';
import type { Request, Response } from 'express';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { SurfaceExecutionEventV1 } from '../../shared/contract/surfaceExecution';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import { getSessionManager } from '../../host/services/infra/sessionManager';
import {
  getSurfaceConversationProjectionService,
} from '../../host/services/surfaceExecution/SurfaceConversationProjectionService';
import { getSurfaceExecutionRuntime } from '../../host/services/surfaceExecution/SurfaceExecutionRuntime';
import { broadcastSSE } from '../helpers/sse';
import { readDevSurfaceExecutionConversationSeed } from './devSurfaceExecutionConversationSeed';
import type { WebRouteLogger } from './routeTypes';

const CONVERSATION_AGENT_ID = 'neo-conversation-acceptance';
const CONVERSATION_CANARY = 'surface-secret-canary-conversation-ux';

interface DevSurfaceExecutionConversationDeps {
  runRegistry: RunRegistry;
  isEnabled: () => boolean;
  logger: WebRouteLogger;
}

function broadcastSurfaceEvent(conversationId: string, event: SurfaceExecutionEventV1): void {
  broadcastSSE(IPC_CHANNELS.AGENT_EVENT, {
    type: 'surface_execution',
    sessionId: conversationId,
    data: event,
  });
}

export function createDevSurfaceExecutionConversationRouter(
  deps: DevSurfaceExecutionConversationDeps,
): Router {
  const router = Router();
  const { runRegistry, isEnabled, logger } = deps;

  router.use((_req: Request, res: Response, next) => {
    if (!isEnabled()) {
      res.status(404).json({ ok: false, error: 'Dev API is disabled.' });
      return;
    }
    next();
  });

  router.post('/seed', async (req: Request, res: Response) => {
    try {
      const seed = readDevSurfaceExecutionConversationSeed(req.body);
      const sessionManager = getSessionManager();
      const conversation = await sessionManager.getSession(seed.conversationId, Number.MAX_SAFE_INTEGER);
      if (!conversation) {
        res.status(404).json({ ok: false, error: 'Conversation is unavailable.' });
        return;
      }
      if (runRegistry.hasSession(seed.conversationId)) {
        res.status(409).json({ ok: false, error: 'Conversation already has an active run.' });
        return;
      }

      const runId = `surface-conversation-acceptance-${Date.now()}`;
      runRegistry.start({ runId, sessionId: seed.conversationId, workspace: process.cwd() });
      const runtime = getSurfaceExecutionRuntime();
      const identity = {
        conversationId: seed.conversationId,
        runId,
        turnId: 'surface-conversation-acceptance-turn',
        agentId: CONVERSATION_AGENT_ID,
        emitSurfaceEvent: (event: SurfaceExecutionEventV1) => (
          broadcastSurfaceEvent(seed.conversationId, event)
        ),
      };
      const prepared = runtime.prepareBrowserSession({ identity });
      const htmlOutput = runtime.outputs.registerLocalOutput({
        subject: prepared.subject,
        conversationId: seed.conversationId,
        path: seed.outputHtmlAssetRef,
        sourceRefs: ['artifact://travel-site-final.html'],
        kind: 'file',
        label: 'travel-site-final.html',
      });
      const imageOutput = runtime.outputs.registerLocalOutput({
        subject: prepared.subject,
        conversationId: seed.conversationId,
        path: seed.outputImageAssetRef,
        sourceRefs: ['artifact://travel-site-final.png'],
        kind: 'artifact',
        label: 'travel-site-final.png',
      });
      if (!htmlOutput || !imageOutput) {
        throw new Error('Production Surface output registry rejected the acceptance artifacts.');
      }
      const target = {
        kind: 'browser' as const,
        browserInstanceId: `managed:conversation:${prepared.session.sessionId}`,
        windowRef: `window:conversation:${prepared.session.sessionId}`,
        tabRef: `tab:conversation:${prepared.session.sessionId}`,
        origin: 'http://127.0.0.1/workbuddy/travel-site',
        documentRevision: 'document-conversation-workbuddy-v2',
        title: 'WorkBuddy 旅行站点 · 已复验',
      };
      runtime.events.publish(prepared.subject, {
        phase: 'prepare',
        status: 'succeeded',
        userSummary: '已建立本次会话独立的托管浏览器环境',
        target,
        evidenceRefs: [],
        artifactRefs: [],
        availableControls: ['pause', 'takeover', 'stop', 'end_session'],
        completedAt: Date.now(),
      });
      runtime.events.publish(prepared.subject, {
        phase: 'prepare',
        status: 'succeeded',
        userSummary: '因为最终产物需要页面截图复验，已从 Computer 返回 Browser',
        target,
        operation: {
          action: 'surface_switch',
          risk: 'control',
          approvalScope: 'from:computer-workbuddy',
          expectedOutcome: '在浏览器中打开最终产物并复验页面截图',
        },
        evidenceRefs: [],
        artifactRefs: [],
        availableControls: ['pause', 'takeover', 'stop', 'end_session'],
        completedAt: Date.now(),
      });
      runtime.recordBrowserObservation({
        identity,
        surfaceSessionId: prepared.session.sessionId,
        target,
        providerGeneration: `managed:conversation:${prepared.session.sessionId}:2`,
        evidenceAssetIds: [],
        userSummary: '已打开生成后的旅行网站首页',
      });
      runtime.grants.issue({
        subject: prepared.subject,
        target,
        capabilities: ['observe', 'input', 'navigate', 'file'],
        dataScopes: ['authorized-target', 'screenshot-proof'],
        actionClasses: ['read', 'write', 'navigation'],
        ttlMs: 15 * 60_000,
      });
      runtime.events.publish(prepared.subject, {
        phase: 'act',
        status: 'succeeded',
        userSummary: '已调整第二张 Hero 图片的裁切与文案',
        target,
        operation: {
          action: '调整图片裁切与文案',
          risk: 'low',
          approvalScope: 'authorized-target',
          expectedOutcome: '图片主体完整且标题不遮挡',
        },
        evidenceRefs: [],
        artifactRefs: [],
        availableControls: ['pause', 'takeover', 'stop', 'end_session'],
        completedAt: Date.now(),
      });
      runtime.events.publish(prepared.subject, {
        phase: 'verify',
        status: 'succeeded',
        userSummary: `已读取最新页面截图；${CONVERSATION_CANARY}`,
        target,
        observation: {
          verdict: 'pass',
          findings: [
            '四个业务板块完整',
            'Hero 图片主体未被裁切',
            `敏感校验串 ${CONVERSATION_CANARY} 不得进入会话展示`,
          ],
          confidence: 0.98,
        },
        evidenceRefs: ['evidence-conversation-screenshot'],
        evidence: [{
          version: 1,
          evidenceId: 'evidence-conversation-screenshot',
          kind: 'screenshot',
          source: 'browser',
          title: '旅行网站最终复验截图',
          summary: '真实 System Chrome 截图已读取；四个板块完整，图片裁切已修复。',
          capturedAt: Date.now(),
          captureContext: {
            target,
            sourceUrl: 'http://127.0.0.1/workbuddy/travel-site',
          },
          assetRef: seed.evidenceAssetRef,
          observationStateId: 'document-conversation-workbuddy-v2',
          redactionStatus: 'clean',
          inspection: {
            captureState: 'captured',
            analysisState: 'analyzed',
            verificationState: 'verified',
            inspectedBy: {
              kind: 'service',
              id: 'conversation-acceptance-deterministic-inspector',
              method: 'dom',
            },
            inspectedAt: Date.now(),
            supportsStepIds: ['observe-page', 'verify-layout', 'verify-image-crop'],
            checklist: [
              { id: 'layout', label: '四个业务板块完整', status: 'passed' },
              { id: 'hero', label: 'Hero 图片主体完整', status: 'passed' },
              { id: 'artifact', label: 'HTML 与 PNG 产物可用', status: 'passed' },
            ],
          },
        }],
        artifactRefs: [
          'artifact://travel-site-final.html',
          'artifact://travel-site-final.png',
          'trace://conversation-execution-proof',
        ],
        availableControls: ['pause', 'takeover', 'stop', 'end_session'],
        completedAt: Date.now(),
      });
      runtime.events.publish(prepared.subject, {
        phase: 'artifact',
        status: 'succeeded',
        userSummary: 'HTML 与 PNG 交付物已保存到会话产物区',
        target,
        evidenceRefs: ['evidence-conversation-screenshot'],
        artifactRefs: ['artifact://travel-site-final.html', 'artifact://travel-site-final.png'],
        availableControls: ['pause', 'takeover', 'stop', 'end_session'],
        completedAt: Date.now(),
      });
      runtime.events.publish(prepared.subject, {
        phase: 'recover',
        status: 'waiting',
        userSummary: '检测到页面 revision 更新，正在基于最新截图恢复',
        target,
        evidenceRefs: ['evidence-conversation-screenshot'],
        artifactRefs: [],
        availableControls: ['pause', 'takeover', 'stop', 'end_session'],
      });

      const projection = getSurfaceConversationProjectionService();
      await projection.flushPersistence(seed.conversationId);
      const snapshot = await projection.getSnapshot(seed.conversationId);
      const projected = snapshot.sessions.find((candidate) => (
        candidate.session.sessionId === prepared.session.sessionId
      ));
      if (!projected?.writable || projected.events.length < 6) {
        throw new Error('Production Surface conversation projection did not expose the seeded live session.');
      }
      res.json({
        ok: true,
        runId,
        surfaceSessionId: prepared.session.sessionId,
        eventCount: projected.events.length,
        writable: projected.writable,
        grantState: projected.grant.state,
        outputCount: projected.outputs.filter((output) => output.ref.startsWith('surface-output://')).length,
      });
    } catch (error) {
      logger.warn('Dev Surface conversation seed failed', error);
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Surface conversation seed failed.',
      });
    }
  });

  return router;
}

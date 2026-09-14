import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// RQ-183 刀 2：session 域单源表化后，本静态门从「比对 web/desktop 两份 switch」改为
// 钉死单源结构的两个落点：表（sessionRoutes.ts）只经 ctx 分发不私连服务实现；
// web context（sessionDomainHandler.ts）的 fork/rewind 构造保持原 web 语义
// （SessionForkService/SessionRewindService 直构，不耦合 checkpoint 截断）。

const routesSource = fs.readFileSync(
  path.resolve(__dirname, '../../../src/host/ipc/domainRoutes/sessionRoutes.ts'),
  'utf8',
);
const webContextSource = fs.readFileSync(
  path.resolve(__dirname, '../../../src/web/sessionDomainHandler.ts'),
  'utf8',
);

/** 从锚点截一段定长窗口（成员体足够覆盖；contain 断言不需要精确块边界），锚点失效即红 */
function memberBody(source: string, anchor: string, windowChars = 1000): string {
  const start = source.indexOf(anchor);
  expect(start, `找不到锚点「${anchor}」——结构变了，更新本门`).toBeGreaterThan(-1);
  return source.slice(start, start + windowChars);
}

describe('session 单源表（sessionRoutes.ts）', () => {
  it('fork/rewind 家族只经 ctx 分发，表内不私连 checkpoint/截断实现', () => {
    for (const anchor of ['fork: async', 'rewindConversation: async', 'rewindToPrompt: async', 'restoreConversationRewind: async']) {
      const body = memberBody(routesSource, anchor);
      expect(body).toContain('ctx.');
      expect(body).not.toContain('rewindFiles');
      expect(body).not.toContain('truncateMessagesAfter');
      expect(body).not.toContain('applyPromptRewind');
      expect(body).not.toContain('getFileCheckpointService');
    }
  });

  it('portability 走 ctx.sessions()（appService 面），不直连 database.importSessionFork', () => {
    for (const call of ['exportSessionFork', 'importSessionFork', 'enqueueSessionForkSync', 'ingestSessionForkSync', 'importReadySessionForkSync', 'searchSessionForkExports', 'readSessionForkTree', 'readSessionForkNeighborhood']) {
      const body = memberBody(routesSource, `${call}: async`, 400);
      expect(body).toContain(`).${call}(`);
      expect(body).not.toContain('database.importSessionFork');
      expect(body).not.toContain('database.publishImportedIsolatedWorkspace');
    }
  });

  it('rewindToPrompt 保留 anchor/userMessage 双名与 legacy 幂等合成', () => {
    const body = memberBody(routesSource, 'rewindToPrompt: async');
    expect(body).toContain('anchorUserMessageId');
    expect(body).toContain('userMessageId');
    expect(body).toContain('legacy:');
  });

  it('delete 统一桌面同款清理：browser link 结束 + 终端 PTY dispose', () => {
    const body = memberBody(routesSource, 'delete: async');
    expect(body).toContain("getUserBrowserLinkService().end(sessionId, 'session-switch')");
    expect(body).toContain('disposeTerminalSession(sessionId)');
    expect(body).toContain('ctx.deleteSession(sessionId)');
  });
});

describe('web context（sessionDomainHandler.ts）保持原 web 构造语义', () => {
  it('forkSession 用 SessionForkService 直构 + runRegistry 状态源', () => {
    const body = memberBody(webContextSource, 'forkSession: async');
    expect(body).toContain('SessionForkService');
    expect(body).toContain('service.createFork(params)');
    expect(body).toContain('ownerUserId: getAuthService().getCurrentUser()?.id ?? null');
    expect(body).not.toContain('rewindFiles');
  });

  it('rewind 家族用 SessionRewindService 直构，落库后双失效', () => {
    for (const anchor of ['rewindConversation: async', 'restoreConversationRewind: async']) {
      const body = memberBody(webContextSource, anchor);
      expect(body).toContain('SessionRewindService');
      expect(body).toContain('ownerUserId: getAuthService().getCurrentUser()?.id ?? null');
      expect(body).toContain('invalidateSessionMessagesProjection');
    }
    expect(memberBody(webContextSource, 'rewindConversation: async')).toContain('.rewindConversation(params)');
    expect(memberBody(webContextSource, 'restoreConversationRewind: async')).toContain('.restoreConversation(params)');
  });

  it('一致动作面走 createSessionApplicationService 惰性装配（现状平移）', () => {
    expect(webContextSource).toContain('createSessionApplicationService(deps)');
    expect(memberBody(webContextSource, 'sessions: async')).toContain('requireSessionBackend');
  });

  it('sm 直调四动作不走 appService（drift 拍板归属 web 的基座行为）', () => {
    for (const anchor of ['listSessions: (', 'loadSession: (', 'deleteSession: (', 'updateSession: (']) {
      expect(memberBody(webContextSource, anchor)).toContain('resolveSessionManager');
    }
  });
});

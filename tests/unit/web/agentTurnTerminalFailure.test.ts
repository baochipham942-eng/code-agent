import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { AgentRunController } from '../../../src/web/routes/agentRunController';
import { buildTurnTerminalFailure } from '../../../src/web/routes/agentTurnTerminalFailure';
import type { WebRouteLogger } from '../../../src/web/routes/routeTypes';

const logger: WebRouteLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createController(): AgentRunController {
  return new AgentRunController({
    res: { writableEnded: false, destroyed: false } as unknown as Response,
    runId: 'run_test',
    sessionId: 'session_test',
    logger,
    tryGetSessionManager: async () => null,
  });
}

describe('buildTurnTerminalFailure', () => {
  it('取消轮不落失败记录（用户主动停不算失败）', () => {
    expect(buildTurnTerminalFailure({
      errorData: { message: 'x', code: 'RUN_FAILED' },
      fallbackMessage: null,
      modelId: 'm',
      runCancelled: true,
    })).toBeNull();
  });

  it('引擎终态载荷优先：RUN_FAILED + 401 文案 → auth 分类，带这一轮真跑的模型', () => {
    const result = buildTurnTerminalFailure({
      errorData: {
        message: '模型鉴权失败：API Key 无效、已过期或没有权限。',
        code: 'RUN_FAILED',
        details: { provider: 'custom-tokenrhythm', model: 'deepseek-v4-flash' },
        failure: { code: 'MODEL_AUTH' },
      },
      fallbackMessage: null,
      modelId: undefined,
      runCancelled: false,
    });
    expect(result?.agentError).toMatchObject({
      category: 'auth',
      httpStatus: 401,
      provider: 'custom-tokenrhythm',
      modelId: 'deepseek-v4-flash',
    });
  });

  it('引擎没发过事件时用抛出错误的 message 兜底（额度话术 → insufficient_balance）', () => {
    const result = buildTurnTerminalFailure({
      errorData: null,
      fallbackMessage: '402 Insufficient quota: 余额不足',
      modelId: 'some-model',
      runCancelled: false,
    });
    expect(result?.agentError).toMatchObject({ category: 'insufficient_balance', modelId: 'some-model' });
  });

  it('空最终回复被引擎转失败的那类消息（RUN_FAILED + 中文说明）保持可分类', () => {
    const result = buildTurnTerminalFailure({
      errorData: {
        message: '任务已结束，执行记录和产物已保留。这一轮没有生成最终说明，请直接查看上面的工具结果。',
        code: 'RUN_FAILED',
      },
      fallbackMessage: null,
      modelId: 'm',
      runCancelled: false,
    });
    // 文案不含可归类信号 → generic，但记录仍在（重试入口保留）
    expect(result?.agentError.category).toBe('generic');
  });

  it('没有任何可分类信息时不造记录（不许编造失败原因）', () => {
    expect(buildTurnTerminalFailure({
      errorData: null,
      fallbackMessage: null,
      modelId: 'm',
      runCancelled: false,
    })).toBeNull();
  });
});

describe('AgentRunController.lastTerminalErrorData', () => {
  it('保留引擎第一条带 message 的终态载荷，catch 裸发的 {message} 不覆盖', () => {
    const controller = createController();
    controller.emitAgentEvent({
      type: 'error',
      data: {
        message: '模型鉴权失败：API Key 无效、已过期或没有权限。',
        code: 'RUN_FAILED',
        details: { provider: 'p', model: 'm' },
        failure: { code: 'MODEL_AUTH' },
      },
    });
    // 引擎 finalize 后再抛，路由 catch 里裸发一条只有 message 的 error
    controller.emitAgentEvent({ type: 'error', data: { message: 'Unauthorized' } });

    expect(controller.lastTerminalErrorData).toMatchObject({
      code: 'RUN_FAILED',
      details: { provider: 'p' },
    });
    expect(controller.hadTerminalError).toBe(true);
    expect(controller.lastTerminalFailure).toMatchObject({ code: 'MODEL_AUTH' });
  });

  it('warning 级 error 不算终态失败', () => {
    const controller = createController();
    controller.emitAgentEvent({ type: 'error', data: { message: 'x', level: 'warning' } });
    expect(controller.hadTerminalError).toBe(false);
    expect(controller.lastTerminalErrorData).toBeNull();
  });
});

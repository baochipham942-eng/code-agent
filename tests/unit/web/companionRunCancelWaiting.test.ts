import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * N-DURABLE-WAITING-NO-EXIT 宿主侧接线（照 companionLibraryCleanup.test.ts 的源码合同先例）：
 * 手机 run.cancel 与桌面 /api/cancel 在 resolve() 落空时都必须兜「恢复成 waiting 的 durable
 * run」——终态化 + 补发 agent_cancelled。行为本体由 durableWaitingRunCancel /
 * registerAgentCancelRoute 两个用例钉住，这里只钉两处入口的接线没被后续改丢。
 */
const read = (file: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/web', file), 'utf8');

describe('waiting durable run cancellation wiring', () => {
  it('app.ts 的 run.cancel 分发在 resolve() 落空时兜底终态化并结算 alreadyTerminal', () => {
    const source = read('app.ts');
    expect(source).toMatch(/findRecoveredWaitingRun\(\{\s*sessionId: command\.sessionId,\s*runId: command\.payload\.runId,/);
    expect(source).toMatch(/terminalRecoveredWaitingRun\(\{ runId: waiting\.runId \}\)/);
    expect(source).toMatch(/publishCompanionEvent\?\.\(command\.sessionId, 'agent_cancelled'/);
    expect(source).toMatch(/settleCommand\(command\.deviceId, command\.commandId, 'accepted', \{\s*alreadyTerminal: true,/);
  });

  it('agent.ts 给 /api/cancel 的 waiting 兜底挂上 companion agent_cancelled 发布', () => {
    const source = read('routes/agent.ts');
    expect(source).toMatch(/registerAgentCancelRoute\(router, runRegistry, deps\.getDurableRunReadService,/);
    expect(source).toMatch(/'agent_cancelled', \{ event: null, runId: recovered\.runId \}/);
  });
});

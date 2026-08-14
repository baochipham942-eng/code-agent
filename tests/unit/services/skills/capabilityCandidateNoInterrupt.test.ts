// ============================================================================
// 零打断回归门（N-CAP1 硬约束 1）
// ============================================================================
// 「本单不许出现任何主动弹窗、卡片、气泡、红点催促」是产品硬约束，
// 而口头声明是拦不住下一次改动的。这里把它钉成机制：
// 走一遍真实的记账路径（agent loop 收尾 → recordCapabilityGapTurn），
// 断言 EventBus 上一条事件都没发出去——探测器是纯记账，没有任何推送出口。
//
// 为什么盯 EventBus：主链路上「让渲染层弹出点什么」的唯一出口就是它
// （publish 带 bridgeToRenderer 会经 EventBridge 转成 IPC 推给 renderer）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

const tmpConfigDir = path.join(os.tmpdir(), `cap-nointerrupt-${process.pid}`);
vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => tmpConfigDir,
}));
// 探测器记账不该碰数据库；真跑时也只是「取本轮 token，取不到算 0」
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => { throw new Error('数据库在本用例里不可用'); },
}));

import { getEventBus, shutdownEventBus } from '../../../../src/host/services/eventing';
import { getComboRecorder } from '../../../../src/host/services/skills/comboRecorder';
import { getCapabilityCandidateStore } from '../../../../src/host/services/skills/capabilityCandidateStore';
import { listCandidates } from '../../../../src/host/services/skills/capabilityGapDetector';
import { recordCapabilityGapTurn } from '../../../../src/host/agent/capabilityGapTurnRecorder';

const SESSION = 'no-interrupt-session';

function toolResult(success = true) {
  return { toolCallId: '', success, output: '', duration: 10 } as never;
}

beforeEach(() => {
  shutdownEventBus();
  getCapabilityCandidateStore().resetForTests();
  getComboRecorder().stopRecording(SESSION);
});

describe('零打断', () => {
  it('记账走完整条真实路径，EventBus 上零事件', async () => {
    const events: string[] = [];
    getEventBus().subscribe('*', (event) => { events.push(`${event.domain}:${event.type}`); });

    const recorder = getComboRecorder();
    recorder.startRecording(SESSION);
    recorder.markTurn(SESSION, '把这批截图里的表格转成 Excel');
    recorder.recordStep(SESSION, 'c1', 'bash', { command: 'screencapture -x a.png' }, toolResult());
    recorder.recordStep(SESSION, 'c2', 'bash', { command: 'tesseract a.png out' }, toolResult());
    recorder.recordStep(SESSION, 'c3', 'write_file', { path: 'out.xlsx' }, toolResult());

    await recordCapabilityGapTurn(SESSION);

    // 账真的记上了（否则这条断言是在给空跑发合格证）
    expect(listCandidates(Date.now())).toHaveLength(1);
    // 而全程一条事件都没往外推
    expect(events).toEqual([]);
  });

  it('探测器与列表模块都不注册任何 EventBus 订阅（没有推送出口）', async () => {
    const bus = getEventBus();
    const subscribe = vi.spyOn(bus, 'subscribe');
    const publish = vi.spyOn(bus, 'publish');

    await getCapabilityCandidateStore().load();
    listCandidates(Date.now());

    expect(subscribe).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});

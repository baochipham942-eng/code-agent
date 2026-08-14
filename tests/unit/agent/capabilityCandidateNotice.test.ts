// ============================================================================
// agent 侧读取路径：每会话首轮注入一次 top3（N-CAP1 / F12）
// ============================================================================
// 三条要钉住的：
//   1. 没有够格候选时**一个字都不注入**（空标签也要付 token）；
//   2. 同一会话只注入一次（候选表是慢变量，不每轮重复付费）；
//   3. 注入文案必须写着「不许主动推销」——本单是零打断期。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

const tmpConfigDir = path.join(os.tmpdir(), `cap-notice-${process.pid}`);
vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => tmpConfigDir,
}));

import { buildCapabilityCandidateNotice } from '../../../src/host/agent/capabilityCandidateNotice';
import { getCapabilityCandidateStore } from '../../../src/host/services/skills/capabilityCandidateStore';
import { listCandidates, observeTurn } from '../../../src/host/services/skills/capabilityGapDetector';

// 注入判据走 Date.now()（读时衰减），夹具时间必须贴着当下——
// 用固定的历史时间戳会被 14 天半衰期直接衰减成不进首屏（第一版就这么红过一次）。
const T0 = Date.now();

function step(toolName: string, command?: string) {
  return {
    toolCallId: `${toolName}-${Math.random()}`,
    toolName,
    args: command ? { command } : {},
    success: true,
    outputPreview: '',
    duration: 10,
    timestamp: T0,
  };
}

/** 攒一条真的进首屏的候选：含 shell 签名 + 重复过 + 成本够 */
function seedAboveFoldCandidate(): void {
  const steps = [
    step('bash', 'screencapture -x a.png'),
    step('bash', 'tesseract a.png out'),
    step('write_file'),
  ];
  observeTurn({ userMessage: '把截图里的表格转成 Excel', steps, tokens: 30_000 }, T0);
  observeTurn({ userMessage: '再转一批', steps, tokens: 30_000 }, T0 + 1000);
}

beforeEach(() => {
  getCapabilityCandidateStore().resetForTests();
});

describe('候选能力注入', () => {
  it('没有够格候选时不注入任何内容', () => {
    expect(buildCapabilityCandidateNotice('s-empty')).toBeNull();
    // 只有一次、且不进首屏的候选也不注入
    observeTurn({ userMessage: 'x', steps: [step('bash', 'ls'), step('read_file')], tokens: 100 }, T0);
    expect(buildCapabilityCandidateNotice('s-lowscore')).toBeNull();
  });

  it('有进首屏的候选时注入一次，同一会话第二轮不再注入', () => {
    seedAboveFoldCandidate();
    expect(listCandidates(T0 + 2000).some((c) => c.aboveFold)).toBe(true);

    const first = buildCapabilityCandidateNotice('s-1');
    expect(first).toContain('已拼凑 2 次');
    // 零打断期的行为约束必须写在注入文案里，不能只写在文档里
    expect(first).toContain('不要主动提起');
    expect(first).toContain('不接受推销');

    expect(buildCapabilityCandidateNotice('s-1')).toBeNull();
    // 换个会话仍然注入（会话级去重，不是全局一次）
    expect(buildCapabilityCandidateNotice('s-2')).not.toBeNull();
  });

  it('没有 sessionId 时不注入（后台/无会话调用不该付这份 token）', () => {
    seedAboveFoldCandidate();
    expect(buildCapabilityCandidateNotice(undefined)).toBeNull();
    expect(buildCapabilityCandidateNotice(null)).toBeNull();
  });
});

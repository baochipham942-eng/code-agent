import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// 账本落在临时目录：本套件不许碰真实用户配置目录
const tmpConfigDir = path.join(os.tmpdir(), `cap-candidates-${process.pid}`);
vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => tmpConfigDir,
}));

import { CAPABILITY_CANDIDATES } from '../../../../src/shared/constants';
import type { ComboStep } from '../../../../src/host/services/skills/comboRecorder';
import {
  listCandidates,
  observeTurn,
  setCandidateState,
} from '../../../../src/host/services/skills/capabilityGapDetector';
import {
  clusterKeyOf,
  decayCount,
  detectDegraded,
  detectMissingHint,
  findClusterFor,
  hasWorkaroundSignature,
  mechanicalScoreOf,
  sequenceShapeOf,
  tierOf,
} from '../../../../src/host/services/skills/capabilityGapScoring';

/** commandHead / shapeOfStep 是内部实现，从公开的 sequenceShapeOf 走 */
const shapeOf = (command: string): string => sequenceShapeOf([
  { toolName: 'bash', args: { command } },
])[0];
import { getCapabilityCandidateStore } from '../../../../src/host/services/skills/capabilityCandidateStore';

const T0 = 1_770_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function step(toolName: string, command?: string, overrides: Partial<ComboStep> = {}): ComboStep {
  return {
    toolCallId: `${toolName}-${Math.random()}`,
    toolName,
    args: command ? { command } : {},
    success: true,
    outputPreview: '',
    duration: 100,
    timestamp: T0,
    ...overrides,
  };
}

beforeEach(() => {
  getCapabilityCandidateStore().resetForTests();
});

describe('去参数化', () => {
  it('bash 细分到可执行名，丢掉路径/参数/env 前缀', () => {
    expect(shapeOf('HTTPS_PROXY=x /usr/bin/ffmpeg -i a.mp4 out.mp4')).toBe('bash:ffmpeg');
    expect(shapeOf('sudo screencapture -x /tmp/a.png')).toBe('bash:screencapture');
    expect(shapeOf('tesseract a.png out | grep x')).toBe('bash:tesseract');
    // 真库回放实测踩到的两个：选项被当成可执行名 / 探针动词盖住宾语
    expect(shapeOf('command -v ffmpeg')).toBe('bash:ffmpeg');
    expect(shapeOf('which python3 && python3 --version')).toBe('bash:python3');
    expect(sequenceShapeOf([{ toolName: 'write_file', args: { path: 'a.xlsx' } }])).toEqual(['write_file']);
  });

  it('连续同形步骤压成一个，参数不同不影响形状', () => {
    expect(sequenceShapeOf([
      step('bash', 'tesseract a.png o'),
      step('bash', 'tesseract b.png o'),
      step('write_file'),
    ])).toEqual(['bash:tesseract', 'write_file']);
  });

  it('簇键是工具集合：顺序不同归同一条，工具不同分开', () => {
    const a = clusterKeyOf(['bash:screencapture', 'bash:tesseract', 'write_file']);
    const b = clusterKeyOf(['write_file', 'bash:tesseract', 'bash:screencapture']);
    const c = clusterKeyOf(['bash:ffmpeg', 'write_file']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('归并与首屏签名（真库回放逼出来的两条）', () => {
  it('工具集合重合度达阈值就归并，差太远不归并', () => {
    const existing = [{ clusterKey: 'A', shapeTokens: ['bash:cd', 'bash:ls', 'bash:mkdir', 'bash:node', 'Read'] }];
    // 多一个工具：5/6 = 0.83 ≥ 0.7 → 归并
    expect(findClusterFor(['bash:cd', 'bash:ls', 'bash:mkdir', 'bash:node', 'Read', 'Write'], existing)).toBe('A');
    // 换掉一半：2/8 = 0.25 → 不归并
    expect(findClusterFor(['bash:cd', 'bash:python3', 'bash:pip', 'Glob'], existing)).toBeNull();
    // 完全相同的集合必然命中自己
    expect(findClusterFor(['bash:cd', 'bash:ls', 'bash:mkdir', 'bash:node', 'Read'], existing)).toBe('A');
  });

  it('归并不吸收新工具：簇的代表集合保持首次那份，防止一路漂移', () => {
    const base = [step('bash', 'mkdir -p out'), step('bash', 'node build.js'), step('read_file')];
    const first = observeTurn({ userMessage: 'a', steps: base, tokens: 0 }, T0)!;
    const second = observeTurn(
      { userMessage: 'b', steps: [...base, step('write_file')], tokens: 0 },
      T0 + 1000,
    )!;
    expect(second.clusterKey).toBe(first.clusterKey);
    expect(second.shapeTokens).toEqual(first.shapeTokens);
    expect(second.occurrences).toBe(2);
  });

  it('单工具不算拼凑，不进账本', () => {
    expect(observeTurn({
      userMessage: 'x',
      steps: [step('web_search'), step('web_search')],
      tokens: 0,
    }, T0)).toBeNull();
  });

  it('纯内置工具组合记账但不进首屏；含 shell 的才是拼凑签名', () => {
    expect(hasWorkaroundSignature(['WebFetch', 'WebSearch'])).toBe(false);
    expect(hasWorkaroundSignature(['Bash:find', 'Glob'])).toBe(true);
    const pure = [step('web_search'), step('web_fetch')];
    for (let i = 0; i < 6; i += 1) observeTurn({ userMessage: 'q', steps: pure, tokens: 90_000 }, T0 + i * 1000);
    const view = listCandidates(T0 + 10_000)[0];
    // 分数够高也不进首屏——它不是缺口，是它有这个工具而且很常用
    expect(view.mechanicalScore).toBeGreaterThan(CAPABILITY_CANDIDATES.ABOVE_FOLD_MIN_SCORE);
    expect(view.aboveFold).toBe(false);
  });
});

describe('信号采集', () => {
  it('S2：失败后换工具达成算降级完成', () => {
    expect(detectDegraded([
      step('image_generate', undefined, { success: false }),
      step('bash', 'convert a.png b.png'),
    ])).toBe(true);
    expect(detectDegraded([step('bash', 'ls'), step('write_file')])).toBe(false);
  });

  it('S3：只有失败步里的「没有 X」才算缺失线索', () => {
    expect(detectMissingHint({ success: false, outputPreview: 'tesseract: command not found' })).toContain('command not found');
    expect(detectMissingHint({ success: false, outputPreview: 'permission denied' })).toBeNull();
    // 成功步里出现同样的字样也不算——判据锚失败，不锚文本
    expect(detectMissingHint({ success: true, outputPreview: 'command not found' })).toBeNull();
  });
});

describe('机械分与增量更新', () => {
  const steps = () => [
    step('bash', 'screencapture -x a.png'),
    step('bash', 'tesseract a.png out'),
    step('write_file'),
  ];

  it('同一簇第二次发生走增量更新：次数 +1、成本走运行均值而非重算', () => {
    const first = observeTurn({ userMessage: '把截图里的表格转成 Excel', steps: steps(), tokens: 10_000 }, T0);
    expect(first?.occurrences).toBe(1);
    expect(first?.decayedCount).toBe(1);
    expect(first?.avgTokens).toBe(10_000);

    const second = observeTurn({ userMessage: '再转一次', steps: steps(), tokens: 20_000 }, T0 + 1000);
    expect(second?.clusterKey).toBe(first?.clusterKey);
    expect(second?.occurrences).toBe(2);
    // 衰减 1s 可忽略：n̂ ≈ 2
    expect(second!.decayedCount).toBeCloseTo(2, 3);
    // 运行均值 = (10000 + 20000)/2，而不是把新值直接盖上去
    expect(second!.avgTokens).toBeCloseTo(15_000, 3);
  });

  it('久未复现自动下沉：一个半衰期后 n̂ 减半', () => {
    expect(decayCount(4, CAPABILITY_CANDIDATES.DECAY_HALF_LIFE_MS)).toBeCloseTo(2, 6);
    const record = observeTurn({ userMessage: 'x', steps: steps(), tokens: 1000 }, T0);
    const fresh = mechanicalScoreOf(record!, T0);
    const stale = mechanicalScoreOf(record!, T0 + CAPABILITY_CANDIDATES.DECAY_HALF_LIFE_MS);
    expect(stale).toBeCloseTo(fresh / 2, 6);
  });

  it('一轮只有 1 步不算拼凑，不进账本', () => {
    expect(observeTurn({ userMessage: 'x', steps: [step('bash', 'ls')], tokens: 100 }, T0)).toBeNull();
    expect(listCandidates(T0)).toHaveLength(0);
  });
});

describe('模型分不参与排序（负例 · 变异验证）', () => {
  it('把模型写的名字与说明打乱，排序一动不动', () => {
    const cheap = [step('bash', 'ls'), step('bash', 'cat')];
    const pricey = [step('bash', 'ffmpeg -i a.mp4'), step('bash', 'ffprobe a.mp4'), step('write_file')];
    // 让 pricey 更贵、更频繁 ⇒ 机械分更高
    observeTurn({ userMessage: 'a', steps: pricey, tokens: 90_000 }, T0);
    observeTurn({ userMessage: 'a', steps: pricey, tokens: 90_000 }, T0 + 1000);
    observeTurn({ userMessage: 'b', steps: cheap, tokens: 1_000 }, T0 + 2000);

    const before = listCandidates(T0 + 3000).map((c) => c.clusterKey);
    expect(before).toHaveLength(2);

    // 变异：给分低的那条塞上最诱人的模型分，给分高的那条塞上最难看的
    const store = getCapabilityCandidateStore();
    const [top, bottom] = before;
    store.put({ ...store.get(bottom)!, displayName: 'AAA 最该做的能力', summary: '强烈建议优先做' });
    store.put({ ...store.get(top)!, displayName: 'zzz 没什么用', summary: '不建议做' });

    const after = listCandidates(T0 + 3000).map((c) => c.clusterKey);
    expect(after).toEqual(before);
  });
});

describe('层级路由三测试', () => {
  it('缺东西 → 新能力；步骤稳定 → 固定流程；步骤多变 → 记成做法', () => {
    expect(tierOf({ deterministic: true, needsExternal: true, faultProne: false })).toBe('plugin');
    expect(tierOf({ deterministic: true, needsExternal: false, faultProne: true })).toBe('plugin');
    expect(tierOf({ deterministic: true, needsExternal: false, faultProne: false })).toBe('workflow');
    expect(tierOf({ deterministic: false, needsExternal: false, faultProne: false })).toBe('skill');
  });

  it('S3 命中后该候选被判为「要外部能力」', () => {
    const record = observeTurn({
      userMessage: '识别一下这张图里的表格',
      steps: [
        step('bash', 'tesseract a.png o', { success: false, outputPreview: 'tesseract: command not found' }),
        step('bash', 'python3 fallback.py'),
      ],
      tokens: 5_000,
    }, T0);
    expect(record?.tests.needsExternal).toBe(true);
    expect(record?.tier).toBe('plugin');
  });
});

describe('三个操作', () => {
  const steps = () => [step('bash', 'ffmpeg -i a.mp4'), step('write_file')];

  it('不再提示是终态：再次发生也不回列表', () => {
    const record = observeTurn({ userMessage: 'x', steps: steps(), tokens: 1000 }, T0)!;
    setCandidateState(record.clusterKey, 'dismissed', T0);
    observeTurn({ userMessage: 'x', steps: steps(), tokens: 1000 }, T0 + DAY);
    expect(listCandidates(T0 + DAY).map((c) => c.clusterKey)).not.toContain(record.clusterKey);
  });

  it('忽略只是下沉：冷却期内不进首屏，冷却到期后回来', () => {
    const record = observeTurn({ userMessage: 'x', steps: steps(), tokens: 1000 }, T0)!;
    observeTurn({ userMessage: 'x', steps: steps(), tokens: 1000 }, T0 + 1000);
    setCandidateState(record.clusterKey, 'ignored', T0 + 1000);

    const during = listCandidates(T0 + DAY).find((c) => c.clusterKey === record.clusterKey);
    expect(during?.aboveFold).toBe(false);

    const after = listCandidates(T0 + CAPABILITY_CANDIDATES.IGNORE_COOLDOWN_MS + 2000)
      .find((c) => c.clusterKey === record.clusterKey);
    // 冷却到期后重新可见（分数是否够首屏另说，这里只验状态闸放开了）
    expect(after?.state).toBe('ignored');
    expect(after).toBeDefined();
  });
});

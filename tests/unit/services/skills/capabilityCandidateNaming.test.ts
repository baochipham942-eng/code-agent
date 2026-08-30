// ============================================================================
// 模型分（人话名 + 一句说明）—— 只写展示字段，且失败必须静默降级
// ============================================================================
// 这一层的风险不是"起得好不好"，是"它会不会把自己的判断塞进排序"，
// 以及"模型不可用时列表会不会空掉/报错"。两条都在这里钉住。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const tmpConfigDir = path.join(os.tmpdir(), `cap-naming-${process.pid}`);
vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => tmpConfigDir,
}));

const quick = vi.hoisted(() => ({
  available: true,
  result: { success: true, content: '' } as { success: boolean; content?: string },
}));
vi.mock('../../../../src/host/model/quickModel', () => ({
  isQuickModelAvailable: () => quick.available,
  quickTask: async () => quick.result,
}));

import { fillMissingNames, fallbackName } from '../../../../src/host/services/skills/capabilityCandidateNaming';
import { getCapabilityCandidateStore } from '../../../../src/host/services/skills/capabilityCandidateStore';
import { listCandidates, observeTurn } from '../../../../src/host/services/skills/capabilityGapDetector';

const T0 = 1_770_000_000_000;

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

function seedCandidate() {
  return observeTurn({
    userMessage: '把这批截图里的表格转成 Excel',
    steps: [step('bash', 'screencapture -x a.png'), step('bash', 'tesseract a.png o'), step('write_file')],
    tokens: 12_000,
  }, T0)!;
}

beforeEach(() => {
  getCapabilityCandidateStore().resetForTests();
  quick.available = true;
  quick.result = { success: true, content: '' };
});

describe('模型分', () => {
  it('起到名字就落账本的展示字段，排序不受影响', async () => {
    const record = seedCandidate();
    const scoreBefore = listCandidates(T0)[0].mechanicalScore;

    quick.result = {
      success: true,
      content: '这是我的回答：[{"index":1,"name":"截图表格转 Excel","summary":"把截图里的表格识别成表格文件"}]',
    };
    expect(await fillMissingNames([record])).toBe(1);

    const after = listCandidates(T0)[0];
    expect(after.displayName).toBe('截图表格转 Excel');
    expect(after.summary).toBe('把截图里的表格识别成表格文件');
    // 起了名字之后机械分一分不动
    expect(after.mechanicalScore).toBe(scoreBefore);

    const ledger = JSON.parse(await fs.readFile(
      path.join(tmpConfigDir, 'capability-candidates.json'),
      'utf-8',
    )) as { candidates: Array<{ displayName?: string }> };
    expect(ledger.candidates[0]?.displayName).toBe('截图表格转 Excel');
  });

  it('模型不可用时落人话兜底名与说明，不暴露工具组合', async () => {
    const record = seedCandidate();

    quick.available = false;
    expect(await fillMissingNames([record])).toBe(1);

    const view = listCandidates(T0)[0];
    expect(view.displayName).toBe('截取并分析屏幕');
    expect(view.summary).toBe('按用户要求截取并分析屏幕');
    expect(view.displayName).not.toContain('bash');
    expect(view.displayName).not.toContain(' + ');
  });

  it('坏 JSON 或失败回复也逐条落人话兜底', async () => {
    const record = seedCandidate();

    quick.result = { success: true, content: '抱歉，我不太确定。' };
    expect(await fillMissingNames([record])).toBe(1);
    expect(getCapabilityCandidateStore().get(record.clusterKey)?.displayName).toBe(fallbackName(record));
  });

  it('模型定额之外的折叠候选也会在同次 LIST 链路落兜底名', async () => {
    const first = seedCandidate();
    const store = getCapabilityCandidateStore();
    const records = [first];
    for (let index = 1; index < 8; index++) {
      const record = {
        ...first,
        clusterKey: `${first.clusterKey}-${index}`,
        shapeTokens: [...first.shapeTokens, `extra-${index}`],
        displayName: undefined,
        summary: undefined,
      };
      store.put(record);
      records.push(record);
    }
    quick.result = {
      success: true,
      content: '[{"index":1,"name":"截图表格转 Excel","summary":"把截图表格转成文件"}]',
    };

    expect(await fillMissingNames(records)).toBe(8);
    expect(records.map((record) => store.get(record.clusterKey)?.displayName)).toEqual([
      '截图表格转 Excel',
      '截取并分析屏幕',
      '截取并分析屏幕',
      '截取并分析屏幕',
      '截取并分析屏幕',
      '截取并分析屏幕',
      '截取并分析屏幕',
      '截取并分析屏幕',
    ]);
  });

  it('已经有名字的候选不再花钱重起', async () => {
    const record = seedCandidate();
    quick.result = { success: true, content: '[{"index":1,"name":"截图表格转 Excel"}]' };
    await fillMissingNames([record]);
    const named = getCapabilityCandidateStore().get(record.clusterKey)!;
    expect(await fillMissingNames([named])).toBe(0);
  });
});

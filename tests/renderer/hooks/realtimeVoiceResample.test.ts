import { describe, it, expect } from 'vitest';
import { resampleTo16k, type ResampleState } from '../../../src/renderer/services/voiceAudioPipeline';

describe('resampleTo16k', () => {
  it('48k -> 16k 抽出约 1/3 的样本数', () => {
    const state: ResampleState = { pos: 0 };
    expect(resampleTo16k(new Float32Array(4800), 48000, state).length).toBe(1600);
  });

  it('满幅输入映射到接近 Int16 上限', () => {
    const state: ResampleState = { pos: 0 };
    const out = resampleTo16k(new Float32Array(4800).fill(1), 48000, state);
    expect(out[0]).toBe(32767);
    expect(out[out.length - 1]).toBe(32767);
  });

  it('跨块保留小数读取位置，且恒不为负（44.1k 比值非整数）', () => {
    const ratio = 44100 / 16000;
    const state: ResampleState = { pos: 0 };
    resampleTo16k(new Float32Array(4096), 44100, state);
    expect(state.pos).toBeGreaterThanOrEqual(0);
    expect(state.pos).toBeLessThan(ratio);
    expect(state.pos % 1).not.toBe(0); // 有小数余量才说明位置真被结转了
    const first = state.pos;
    resampleTo16k(new Float32Array(4096), 44100, state);
    expect(state.pos).not.toBe(first); // 第二块从结转位置继续，不是复位重来
  });

  it('负余量回归：连续多块不产生 NaN', () => {
    const state: ResampleState = { pos: 0 };
    for (let block = 0; block < 5; block += 1) {
      const out = resampleTo16k(new Float32Array(4096).fill(0.5), 48000, state);
      expect(out.some((v) => Number.isNaN(v))).toBe(false);
    }
  });
});

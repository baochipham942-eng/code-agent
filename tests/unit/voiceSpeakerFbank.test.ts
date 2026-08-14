import { describe, expect, it } from 'vitest';
import {
  FBANK_MEL_BINS,
  computeFbank,
  cosineSimilarity,
  pcm16ToFloat32,
} from '../../src/host/services/voice/speakerFbank';

function sine(freq: number, seconds: number, sampleRate = 16_000, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

describe('speakerFbank', () => {
  it('帧数按 25ms 窗 / 10ms 移计算，1 秒音频 = 98 帧 × 80 维', () => {
    const { data, frames } = computeFbank(sine(440, 1));
    expect(frames).toBe(Math.floor((16_000 - 400) / 160) + 1);
    expect(data.length).toBe(frames * FBANK_MEL_BINS);
  });

  it('不足一帧返回 frames=0（调用方按片段过短处理）', () => {
    expect(computeFbank(new Float32Array(399)).frames).toBe(0);
    expect(computeFbank(new Float32Array(0)).frames).toBe(0);
  });

  it('CMN 后逐维时间均值为 0', () => {
    const { data, frames } = computeFbank(sine(700, 0.5));
    for (let m = 0; m < FBANK_MEL_BINS; m++) {
      let s = 0;
      for (let f = 0; f < frames; f++) s += data[f * FBANK_MEL_BINS + m];
      expect(Math.abs(s / frames)).toBeLessThan(1e-4);
    }
  });

  it('不同频率的正弦波在 mel 维上能量分布不同（特征真的在看频谱）', () => {
    const low = computeFbank(sine(200, 0.5));
    const high = computeFbank(sine(3_000, 0.5));
    // CMN 前的绝对能量被归一了，改比帧内分布：取第一帧向量比 cosine，应明显不同
    const a = low.data.slice(0, FBANK_MEL_BINS);
    const b = high.data.slice(0, FBANK_MEL_BINS);
    expect(cosineSimilarity(Float32Array.from(a), Float32Array.from(b))).toBeLessThan(0.9);
  });

  it('pcm16ToFloat32 归一到 [-1,1] 且保留符号', () => {
    const buf = Buffer.alloc(6);
    buf.writeInt16LE(32767, 0);
    buf.writeInt16LE(-32768, 2);
    buf.writeInt16LE(0, 4);
    const f = pcm16ToFloat32(buf);
    expect(f[0]).toBeCloseTo(1, 3);
    expect(f[1]).toBeCloseTo(-1, 3);
    expect(f[2]).toBe(0);
  });

  it('cosineSimilarity：同向量=1，正交≈0，零向量=0', () => {
    const a = Float32Array.from([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(new Float32Array(3), a)).toBe(0);
  });
});

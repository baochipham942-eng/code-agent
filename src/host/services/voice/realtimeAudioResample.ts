// realtimeTransport 的音频重采样（N-MAXLINES-MINEFIELD-2-FU1-S3 逐字拆出）。行为零变化，只做代码搬家。

/** Renderer/原生采集链固定给 16k PCM16；OpenAI 当前 Realtime WS 要求 24k。 */
export function resamplePcm16Mono(frame: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || frame.byteLength < 4) return frame;
  const input = new Int16Array(frame.buffer, frame.byteOffset, Math.floor(frame.byteLength / 2));
  const outputLength = Math.max(1, Math.round(input.length * toRate / fromRate));
  const output = Buffer.allocUnsafe(outputLength * 2);
  for (let index = 0; index < outputLength; index += 1) {
    const source = index * fromRate / toRate;
    const leftIndex = Math.min(input.length - 1, Math.floor(source));
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const weight = source - leftIndex;
    const sample = Math.round(input[leftIndex] * (1 - weight) + input[rightIndex] * weight);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
  }
  return output;
}

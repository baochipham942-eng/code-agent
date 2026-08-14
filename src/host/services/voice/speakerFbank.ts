// ============================================================================
// 声纹前端特征：kaldi 风格 80 维 log-mel fbank + 时间均值归一（CMN）
//
// 对齐 3D-Speaker speakerlab 推理预处理（16k / 25ms 帧 / 10ms 移 / povey 窗 /
// 预加重 0.97 / 80 mel / 减时间均值），供 CAM++ ONNX（输入 [N, T, 80]）消费。
// 纯函数、零依赖、只吃内存里的 PCM——音频不落盘是 L7 语音线硬纪律。
// ============================================================================

export const FBANK_SAMPLE_RATE = 16_000;
export const FBANK_MEL_BINS = 80;

const FRAME_LEN = 400; // 25ms @16k
const FRAME_SHIFT = 160; // 10ms @16k
const NFFT = 512;
const PRE_EMPHASIS = 0.97;
const MEL_LOW_HZ = 20;
const MEL_HIGH_HZ = 8_000;

function poveyWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)), 0.85);
  return w;
}
const WINDOW = poveyWindow(FRAME_LEN);

function melScale(hz: number): number {
  return 1127 * Math.log(1 + hz / 700);
}

function buildMelBanks(): Float32Array[] {
  const bins = NFFT / 2 + 1;
  const melLow = melScale(MEL_LOW_HZ);
  const melHigh = melScale(MEL_HIGH_HZ);
  const banks: Float32Array[] = [];
  for (let m = 0; m < FBANK_MEL_BINS; m++) {
    const left = melLow + ((melHigh - melLow) * m) / (FBANK_MEL_BINS + 1);
    const center = melLow + ((melHigh - melLow) * (m + 1)) / (FBANK_MEL_BINS + 1);
    const right = melLow + ((melHigh - melLow) * (m + 2)) / (FBANK_MEL_BINS + 1);
    const w = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const mel = melScale((k * FBANK_SAMPLE_RATE) / NFFT);
      if (mel > left && mel < right) {
        w[k] = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center);
      }
    }
    banks.push(w);
  }
  return banks;
}
const MEL_BANKS = buildMelBanks();

/** 迭代式 radix-2 FFT，原地计算。NFFT 固定 512（2 的幂），不做通用性校验。 */
function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

export interface FbankResult {
  /** 行优先 [frames × 80]，已做 CMN */
  data: Float32Array;
  frames: number;
}

/**
 * PCM（Float32，[-1,1]，16k mono）→ 80 维 log-mel fbank + CMN。
 * 不足一帧（<25ms）返回 frames=0，调用方按「片段过短」处理，不许拿去推理。
 */
export function computeFbank(pcm: Float32Array): FbankResult {
  const frames = pcm.length >= FRAME_LEN ? Math.floor((pcm.length - FRAME_LEN) / FRAME_SHIFT) + 1 : 0;
  if (frames === 0) return { data: new Float32Array(0), frames: 0 };
  const out = new Float32Array(frames * FBANK_MEL_BINS);
  const re = new Float32Array(NFFT);
  const im = new Float32Array(NFFT);
  for (let f = 0; f < frames; f++) {
    re.fill(0);
    im.fill(0);
    const off = f * FRAME_SHIFT;
    let mean = 0;
    for (let i = 0; i < FRAME_LEN; i++) mean += pcm[off + i];
    mean /= FRAME_LEN;
    for (let i = FRAME_LEN - 1; i > 0; i--) {
      re[i] = (pcm[off + i] - mean - PRE_EMPHASIS * (pcm[off + i - 1] - mean)) * WINDOW[i];
    }
    re[0] = (pcm[off] - mean) * (1 - PRE_EMPHASIS) * WINDOW[0];
    fftInPlace(re, im);
    for (let m = 0; m < FBANK_MEL_BINS; m++) {
      let e = 0;
      const bank = MEL_BANKS[m];
      for (let k = 0; k <= NFFT / 2; k++) {
        if (bank[k] !== 0) e += bank[k] * (re[k] * re[k] + im[k] * im[k]);
      }
      out[f * FBANK_MEL_BINS + m] = Math.log(Math.max(e, 1e-10));
    }
  }
  // CMN：逐维减时间均值（3D-Speaker 推理側同款）
  for (let m = 0; m < FBANK_MEL_BINS; m++) {
    let s = 0;
    for (let f = 0; f < frames; f++) s += out[f * FBANK_MEL_BINS + m];
    s /= frames;
    for (let f = 0; f < frames; f++) out[f * FBANK_MEL_BINS + m] -= s;
  }
  return { data: out, frames };
}

/** PCM16LE Buffer → Float32Array（[-1,1]）。上行帧就是这个编码（16k mono）。 */
export function pcm16ToFloat32(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na * nb);
  return denom > 0 ? dot / denom : 0;
}

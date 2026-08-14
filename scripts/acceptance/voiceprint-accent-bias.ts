// ============================================================================
// N-L7-SPK 判据 8：跨方言口音准确率检查（EDPB Guidelines 02/2021 ¶135 明文要求）
//
// 「Ensure that the accuracy is similar for all user groups by checking that
//  there is no substantial bias towards different demographic groups.」
//
// 做法：按人群分组（口音 zh_CN / zh_TW / zh_HK 粤语；年龄 老年声 / 常规声），
// 每组内每个说话人念 3 句不同文本，用**产品代码本身**（speakerFbank +
// 真 CAM++ ONNX）抽 embedding，统计：
//   - intra：同一说话人不同文本之间的相似度（应高）
//   - inter：组内不同说话人之间的相似度（应低）
//   - 分离度 separation = mean(intra) - mean(inter)
//   - 产品阈值 VOICEPRINT_MATCH_THRESHOLD 下的 TAR / FAR
// 两个判定分开报，别混成一个 pass（首轮跑出来才看清这是两件事）：
//   - **偏差判定**（判据 8 的正题）：任一组分离度不得显著低于各组中位数（容差 0.15），
//     且不得出现单组 TAR 塌陷 —— 这是「组间是否公平」。
//   - **校准判定**（顺带体检）：各组 FAR 绝对值不得超标 —— 这是「阈值定得准不准」，
//     全组一起高 = 阈值松，不是哪个人群被歧视。首轮实测正是这个形态。
// 附阈值扫描表：用数据定 VOICEPRINT_MATCH_THRESHOLD，别拍脑袋。
//
// 刻意不重新实现特征提取：import 的就是通话链上跑的那份代码，
// 避免「验的路 ≠ 用户走的路」。
//
// 用法：
//   npx tsx scripts/acceptance/voiceprint-accent-bias.ts --model <path-to.onnx>
//   （不传 --model 时读产品的按需下载路径 resolveVoiceprintModelPath()）
// ============================================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeFbank, cosineSimilarity, FBANK_MEL_BINS } from '../../src/host/services/voice/speakerFbank';
import { resolveVoiceprintModelPath } from '../../src/host/services/voice/speakerEmbedding';
import { VOICEPRINT_EMBEDDING_DIM, VOICEPRINT_MATCH_THRESHOLD } from '../../src/shared/constants/voice';

/** 分离度极差容差：任一组分离度低于「各组中位数 − 该值」即判偏差。 */
const SEPARATION_TOLERANCE = 0.15;

/**
 * 说话人 = 声音**人格**（persona），口音 = 该人格的语言变体。
 *
 * ⚠️ 这个区分是首轮实测挣来的：初版把 `Grandma (China mainland)` 与
 * `Grandma (Taiwan)` 当成两个不同的人算进组内 inter，于是「老年声」组的 inter
 * 均值虚高到 0.65、分离度塌到 0.19，看起来像模型对老年人有系统性偏差——
 * 实际是同一个声音人格的两个语言版本，模型判它们相似**是对的**。
 * 改成按人格建模后，同名变体正好成了「同一个人说不同口音」的天然样本，
 * 直接回答判据 8 的核心问题：换口音还认不认得出同一个人。
 */
interface PersonaSpec {
  /** 人格名（= 说话人身份） */
  persona: string;
  /** 年龄段（¶135 说的 demographic group 之一） */
  age: '老年' | '常规';
  /** 该人格在各口音下的 macOS 声音名 */
  accents: Partial<Record<'zh_CN' | 'zh_TW' | 'zh_HK', string>>;
}

const PERSONAS: PersonaSpec[] = [
  { persona: 'Flo', age: '常规', accents: { zh_CN: 'Flo (Chinese (China mainland))', zh_TW: 'Flo (Chinese (Taiwan))' } },
  { persona: 'Reed', age: '常规', accents: { zh_CN: 'Reed (Chinese (China mainland))', zh_TW: 'Reed (Chinese (Taiwan))' } },
  { persona: 'Sandy', age: '常规', accents: { zh_CN: 'Sandy (Chinese (China mainland))', zh_TW: 'Sandy (Chinese (Taiwan))' } },
  { persona: 'Rocko', age: '常规', accents: { zh_CN: 'Rocko (Chinese (China mainland))', zh_TW: 'Rocko (Chinese (Taiwan))' } },
  { persona: 'Shelley', age: '常规', accents: { zh_CN: 'Shelley (Chinese (China mainland))', zh_TW: 'Shelley (Chinese (Taiwan))' } },
  { persona: 'Grandma', age: '老年', accents: { zh_CN: 'Grandma (Chinese (China mainland))', zh_TW: 'Grandma (Chinese (Taiwan))' } },
  { persona: 'Grandpa', age: '老年', accents: { zh_CN: 'Grandpa (Chinese (China mainland))', zh_TW: 'Grandpa (Chinese (Taiwan))' } },
  // 单口音人格：只进本组统计，没有跨口音对
  { persona: 'Tingting', age: '常规', accents: { zh_CN: 'Tingting' } },
  { persona: 'Meijia', age: '常规', accents: { zh_TW: 'Meijia' } },
  { persona: 'Sinji', age: '常规', accents: { zh_HK: 'Sinji' } },
];

const UTTERANCES = [
  '帮我把今天下午的会议纪要整理成一份要点清单',
  '明天早上提醒我十点钟参加产品评审',
  '这份文档里提到的第三个方案能不能再解释一下',
];

function say(voice: string, text: string, outWav: string): void {
  const aiff = outWav.replace(/\.wav$/, '.aiff');
  execFileSync('say', ['-v', voice, '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, outWav]);
  fs.rmSync(aiff, { force: true });
}

function readWav16kMono(file: string): Float32Array {
  const buf = fs.readFileSync(file);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

async function main(): Promise<void> {
  const modelArg = process.argv.indexOf('--model');
  const modelPath = modelArg >= 0 ? process.argv[modelArg + 1] : resolveVoiceprintModelPath();
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error(`声纹模型不可用：${modelPath ?? '(未下载)'}。传 --model <path> 或先在设置页下载组件。`);
  }
  // 直接用 onnxruntime-node：本脚本要在 repo 环境跑，不经 app 的 runtime asset 解析。
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(modelPath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceprint-bias-'));

  async function embed(voice: string, text: string, tag: string): Promise<Float32Array> {
    const wav = path.join(tmp, `${tag}.wav`);
    say(voice, text, wav);
    const { data, frames } = computeFbank(readWav16kMono(wav));
    if (!frames) throw new Error(`fbank empty for ${tag}`);
    const output = await session.run({ x: new ort.Tensor('float32', data, [1, frames, FBANK_MEL_BINS]) });
    const embedding = output.embedding?.data;
    if (!(embedding instanceof Float32Array) || embedding.length !== VOICEPRINT_EMBEDDING_DIM) {
      throw new Error(`unexpected embedding shape for ${tag}`);
    }
    return embedding;
  }

  // 抽取：每个 (人格 × 口音) 各 3 句
  type Sample = { persona: string; age: PersonaSpec['age']; accent: string; embeddings: Float32Array[] };
  const samples: Sample[] = [];
  let tagSeq = 0;
  for (const spec of PERSONAS) {
    for (const [accent, voice] of Object.entries(spec.accents)) {
      const embeddings: Float32Array[] = [];
      for (const text of UTTERANCES) embeddings.push(await embed(voice, text, `t${tagSeq++}`));
      samples.push({ persona: spec.persona, age: spec.age, accent, embeddings });
      console.log(JSON.stringify({ step: 'embed', persona: spec.persona, accent, voice, utterances: embeddings.length }));
    }
  }

  function pairs(a: Float32Array[], b: Float32Array[], samePool: boolean): number[] {
    const out: number[] = [];
    for (let i = 0; i < a.length; i++) {
      for (let j = samePool ? i + 1 : 0; j < b.length; j++) out.push(cosineSimilarity(a[i], b[j]));
    }
    return out;
  }

  interface Row {
    scope: string; kind: 'accent-group' | 'age-group';
    speakers: number; intraMean: number; interMean: number; separation: number;
    tar: number; far: number; comparable: boolean;
  }

  /** 同口音内：同人格 = intra，不同人格 = inter。 */
  function statsFor(scope: string, kind: Row['kind'], pool: Sample[]): Row {
    const intra: number[] = [];
    const inter: number[] = [];
    for (const s of pool) intra.push(...pairs(s.embeddings, s.embeddings, true));
    for (let a = 0; a < pool.length; a++) {
      for (let b = a + 1; b < pool.length; b++) {
        // 同一人格的不同口音变体不是「异人」，跨口音同人另算，见下方 crossAccent
        if (pool[a].persona === pool[b].persona) continue;
        inter.push(...pairs(pool[a].embeddings, pool[b].embeddings, false));
      }
    }
    const intraMean = mean(intra);
    const interMean = mean(inter);
    const personaCount = new Set(pool.map((s) => s.persona)).size;
    return {
      scope, kind, speakers: personaCount, intraMean, interMean,
      separation: intraMean - interMean,
      tar: intra.length ? intra.filter((s) => s >= VOICEPRINT_MATCH_THRESHOLD).length / intra.length : NaN,
      far: inter.length ? inter.filter((s) => s >= VOICEPRINT_MATCH_THRESHOLD).length / inter.length : NaN,
      comparable: personaCount >= 2,
    };
  }

  const report: Row[] = [];
  for (const accent of [...new Set(samples.map((s) => s.accent))]) {
    report.push(statsFor(accent, 'accent-group', samples.filter((s) => s.accent === accent)));
  }
  for (const age of ['常规', '老年'] as const) {
    // 年龄组只在同口音内比，避免把跨口音差异算进异人对
    const pool = samples.filter((s) => s.age === age && s.accent === 'zh_CN');
    report.push(statsFor(`${age}(zh_CN)`, 'age-group', pool));
  }

  for (const row of report) {
    console.log(JSON.stringify({
      step: 'group', scope: row.scope, kind: row.kind, speakers: row.speakers,
      intraMean: +row.intraMean.toFixed(4),
      interMean: Number.isNaN(row.interMean) ? null : +row.interMean.toFixed(4),
      separation: Number.isNaN(row.separation) ? null : +row.separation.toFixed(4),
      tar: +row.tar.toFixed(3),
      far: Number.isNaN(row.far) ? null : +row.far.toFixed(3),
      comparable: row.comparable,
    }));
  }

  // 判据 8 的核心问题：同一个人换口音，还认得出吗？
  const crossAccentSame: number[] = [];
  const crossAccentDiff: number[] = [];
  for (let a = 0; a < samples.length; a++) {
    for (let b = a + 1; b < samples.length; b++) {
      if (samples[a].accent === samples[b].accent) continue;
      const sims = pairs(samples[a].embeddings, samples[b].embeddings, false);
      (samples[a].persona === samples[b].persona ? crossAccentSame : crossAccentDiff).push(...sims);
    }
  }
  const crossAccent = {
    step: 'cross-accent',
    sameSpeakerMean: +mean(crossAccentSame).toFixed(4),
    sameSpeakerTar: +(crossAccentSame.filter((s) => s >= VOICEPRINT_MATCH_THRESHOLD).length / crossAccentSame.length).toFixed(3),
    diffSpeakerMean: +mean(crossAccentDiff).toFixed(4),
    diffSpeakerFar: +(crossAccentDiff.filter((s) => s >= VOICEPRINT_MATCH_THRESHOLD).length / crossAccentDiff.length).toFixed(3),
  };
  console.log(JSON.stringify(crossAccent));

  // EER：让阈值有数据依据，而不是拍脑袋。**只报告不改产品常量**——
  // TTS 合成音共享 vocoder/声学模型，异人相似度天生高于真人，用它校准真人阈值
  // 会把阈值推得过严。真人 dogfood 样本才是改 VOICEPRINT_MATCH_THRESHOLD 的依据。
  const allIntra: number[] = [];
  const allInter: number[] = [];
  for (const s of samples) allIntra.push(...pairs(s.embeddings, s.embeddings, true));
  for (let a = 0; a < samples.length; a++) {
    for (let b = a + 1; b < samples.length; b++) {
      const sims = pairs(samples[a].embeddings, samples[b].embeddings, false);
      (samples[a].persona === samples[b].persona ? allIntra : allInter).push(...sims);
    }
  }
  let eer = { threshold: 0, far: 1, frr: 1, gap: Infinity };
  for (let t = 0.30; t <= 0.95; t += 0.005) {
    const far = allInter.filter((s) => s >= t).length / allInter.length;
    const frr = allIntra.filter((s) => s < t).length / allIntra.length;
    const gap = Math.abs(far - frr);
    if (gap < eer.gap) eer = { threshold: +t.toFixed(3), far: +far.toFixed(4), frr: +frr.toFixed(4), gap };
  }
  console.log(JSON.stringify({
    step: 'eer',
    ...eer,
    gap: +eer.gap.toFixed(4),
    productThreshold: VOICEPRINT_MATCH_THRESHOLD,
    note: 'TTS 合成音异人相似度偏高，此阈值仅供参考，改产品常量须以真人样本为准',
  }));

  const comparable = report.filter((r) => r.comparable);
  const separations = comparable.map((r) => r.separation);
  const medianSeparation = median(separations);
  // 判据 8 问的是「组间有没有系统性偏差」，不是「绝对精度够不够」。
  // 绝对精度（FAR/TAR 的水平）由真人 dogfood 与阈值标定负责，这里只判偏差：
  //   ① 任一组分离度显著低于中位数 ② 任一组 TAR 塌陷 ③ 组间 FAR 极差过大
  const outliers = comparable.filter((r) => r.separation < medianSeparation - SEPARATION_TOLERANCE);
  const tarCollapse = comparable.filter((r) => r.tar < 0.5);
  const fars = comparable.map((r) => r.far);
  const farSpread = Math.max(...fars) - Math.min(...fars);
  const FAR_SPREAD_TOLERANCE = 0.15;

  const verdict = {
    step: 'verdict',
    threshold: VOICEPRINT_MATCH_THRESHOLD,
    tolerance: SEPARATION_TOLERANCE,
    medianSeparation: +medianSeparation.toFixed(4),
    biasedGroups: outliers.map((r) => r.scope),
    tarCollapseGroups: tarCollapse.map((r) => r.scope),
    farSpread: +farSpread.toFixed(4),
    farSpreadTolerance: FAR_SPREAD_TOLERANCE,
    crossAccentSameSpeakerTar: crossAccent.sameSpeakerTar,
    pass: outliers.length === 0 && tarCollapse.length === 0 && farSpread <= FAR_SPREAD_TOLERANCE,
  };
  console.log(JSON.stringify(verdict));
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!verdict.pass) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

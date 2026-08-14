// ============================================================================
// 声纹 embedding 推理（N-L7-SPK）：CAM++ zh-cn ONNX，本地推理
//
// 模型分发按 L0 拍板走按需下载（不随包，安装包体积零增长）：
//   1. 首选 <用户数据目录>/voiceprint-model/<文件名>（设置页触发下载落这里）；
//   2. 兜底 runtime asset 资源路径（将来模型产物进 OSS manifest / bundle 时零改动接上）。
// 模型缺失/运行时缺失 = 声纹能力整体不可用，createSpeakerEmbedder 返回 null，
// 上层完全跳过声纹链路（fail-open 回现状）。
//
// EDPB Guidelines 02/2021 ¶133：「Voice models should be generated, stored and
// matched exclusively on the local device, not in remote servers.」——本文件是
// 这条的落点：推理只在本机，embedding 不出程序边界。
// ============================================================================

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { InferenceSession } from 'onnxruntime-node';
import {
  VOICEPRINT_EMBEDDING_DIM,
  VOICEPRINT_MODEL_DIR,
  VOICEPRINT_ONNX_ASSET_ID,
  VOICEPRINT_MODEL_FILE,
  VOICEPRINT_MODEL_SHA256,
  VOICEPRINT_MODEL_URL,
} from '../../../shared/constants/voice';
import { getUserConfigDir } from '../../config/configPaths';
import { resolveExistingResource } from '../../runtime/runtimeAssetResolver';
import { loadOrtRuntimeForModule } from '../desktop/audioVadRuntime';
import { createLogger } from '../infra/logger';
import { computeFbank, FBANK_MEL_BINS } from './speakerFbank';

const logger = createLogger('SpeakerEmbedding');

function getVoiceprintModelDir(): string {
  return path.join(getUserConfigDir(), VOICEPRINT_MODEL_DIR);
}

/** 模型文件按序找：按需下载目录 → runtime asset 资源路径。找不到 = 能力不可用。 */
function resolveVoiceprintModelPath(): string | null {
  const downloaded = path.join(getVoiceprintModelDir(), VOICEPRINT_MODEL_FILE);
  if (fs.existsSync(downloaded)) return downloaded;
  return resolveExistingResource(path.join('voiceprint', VOICEPRINT_MODEL_FILE));
}

export interface VoiceprintRuntimeStatus {
  /** 模型文件在不在（决定设置页显示「下载」还是「已就绪」）。 */
  modelReady: boolean;
  /** ONNX 运行时在不在（Intel/Win 缺 darwin-arm64 外的产物，缺了下载模型也没用）。 */
  runtimeReady: boolean;
}

export function getVoiceprintRuntimeStatus(): VoiceprintRuntimeStatus {
  return {
    modelReady: resolveVoiceprintModelPath() !== null,
    runtimeReady: loadOrtRuntimeForModule(__dirname).ort !== null,
  };
}

export interface SpeakerEmbedder {
  /** 16k mono Float32 PCM → 192 维声纹向量；失败返回 null（上层 fail-open）。 */
  embedPcm(pcm: Float32Array): Promise<Float32Array | null>;
  dispose(): void;
}

/**
 * 每通电话建一个 embedder（session 创建实测 186ms，摊在拨号期）。
 * 模型/运行时缺失时返回 null——调用方据此完全跳过声纹链路。
 *
 * 🔴 缺失必须出声（2026-08-14 真机腿的教训）：首轮真机跑完，声纹链路**一条日志都没有**——
 * 打包态没有 onnxruntime-node（它是 delivery:'optional' 的按需下载资产，全新数据目录从没下过），
 * 于是这里静默返回 null，通话照常跑，用户以为声纹在工作，日志里查不到任何痕迹。
 * fail-open 说的是**行为**不改变，不是**失败不留痕**。
 */
export async function createSpeakerEmbedder(): Promise<SpeakerEmbedder | null> {
  const modelPath = resolveVoiceprintModelPath();
  const runtime = modelPath ? loadOrtRuntimeForModule(__dirname) : { ort: null, attempts: [] };
  const ort = runtime.ort;
  if (!modelPath || !ort) {
    logger.warn('voiceprint disabled: prerequisite missing', {
      modelReady: modelPath !== null,
      runtimeReady: ort !== null,
      hint: modelPath === null
        ? '声纹模型未下载：设置 → 语音 → 声纹身份 → 下载声纹组件'
        : '本地推理运行时缺失（onnxruntime 按需资产未安装）',
      // 装了却加载不了时，光说「缺失」没法判因——把每条候选路径的真实错误带出来
      ...(runtime.attempts.length ? { attempts: runtime.attempts } : {}),
    });
    return null;
  }
  let session: InferenceSession;
  try {
    session = await ort.InferenceSession.create(modelPath);
  } catch (error) {
    logger.warn('voiceprint model load failed', {
      message: error instanceof Error ? error.message : 'unknown',
    });
    return null;
  }
  return {
    async embedPcm(pcm) {
      const { data, frames } = computeFbank(pcm);
      if (!frames) return null;
      try {
        const input = new ort.Tensor('float32', data, [1, frames, FBANK_MEL_BINS]);
        const output = await session.run({ x: input });
        const embedding = output.embedding?.data;
        if (!(embedding instanceof Float32Array) || embedding.length !== VOICEPRINT_EMBEDDING_DIM) {
          return null;
        }
        return embedding;
      } catch (error) {
        logger.warn('voiceprint inference failed', {
          message: error instanceof Error ? error.message : 'unknown',
        });
        return null;
      }
    },
    dispose() {
      void (session as { release?: () => Promise<void> }).release?.();
    },
  };
}

/**
 * 「下载声纹组件」要备齐**两样**：ONNX 运行时（按需资产，与桌面 VAD 共用同一份）
 * 与声纹模型文件。首轮真机腿只备了后者，结果打包态里根本没有 onnxruntime-node，
 * 声纹链路整条静默失效——所以运行时这一步不能省。
 *
 * 运行时走仓内既有机制（`prepareRuntimeAssetOnDemand`，同 playwright/desktop VAD 先例），
 * 模型走固定 URL + SHA256（等模型产物进 OSS manifest 后合并成一次调用）。
 */
export async function prepareVoiceprintPrerequisites(): Promise<VoiceprintRuntimeStatus> {
  if (!loadOrtRuntimeForModule(__dirname).ort) {
    // 与 desktop.ipc 的 startAudioCapture 同款：只在 arm64 mac 上有产物，其余平台
    // 拿不到就维持缺失态（设置页据此显示「本机暂不可用」，不是假装能下）。
    try {
      const { isUpdateServiceInitialized, prepareRuntimeAssetOnDemand } = await import('../cloud/updateService');
      if (isUpdateServiceInitialized()) {
        await prepareRuntimeAssetOnDemand(VOICEPRINT_ONNX_ASSET_ID);
        logger.info('voiceprint onnx runtime prepared');
      }
    } catch (error) {
      logger.warn('voiceprint onnx runtime prepare failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  if (!resolveVoiceprintModelPath()) await downloadVoiceprintModel();
  return getVoiceprintRuntimeStatus();
}

/**
 * 按需下载模型文件。固定 URL + 固定 SHA256，校验不过即删——
 * 与 updateService.downloadVerifiedFile 同形（那是私有方法，这里体量不值得开洞）。
 * 代理跟 gitDownloader 同款（GitHub 直连在国内不可达）。
 */
async function downloadVoiceprintModel(): Promise<VoiceprintRuntimeStatus> {
  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  const response = await axios.get<ArrayBuffer>(VOICEPRINT_MODEL_URL, {
    responseType: 'arraybuffer',
    ...(httpsAgent ? { httpsAgent, proxy: false as const } : {}),
  });
  const bytes = Buffer.from(response.data);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== VOICEPRINT_MODEL_SHA256) {
    throw new Error('voiceprint model sha256 mismatch');
  }
  const dir = getVoiceprintModelDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, VOICEPRINT_MODEL_FILE);
  const tmp = `${dest}.download`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
  logger.info('voiceprint model downloaded', { bytes: bytes.length });
  return getVoiceprintRuntimeStatus();
}

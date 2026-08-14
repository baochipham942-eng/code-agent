// ============================================================================
// 通话录音（N-L7-REC）—— 一通电话一个 recorder，上行/下行各落一路 WAV
// ============================================================================
// 落盘点选 host 不选 renderer：renderer 侧有两个采集管线实现（WebView 的
// VoiceAudioPipeline 与原生 AEC 的 NativeVoiceAudioPipeline），两处独立的 onFrame；
// 而它们送出去的目的地是同一条 renderer→host WS，到 host 汇成一个入口。选 host
// 一处接线覆盖两条链，且 renderer 没有 fs（落盘只能逐帧走 IPC 过桥，而这些帧本来
// 就已经在过 WS 到 host 了）。
//
// 隐私边界（工单 §4 的承重设计）：开关默认关，闸在拨号那一刻判一次——不在每帧判，
// 每帧读配置是白烧 CPU，且中途改开关会产出半截文件，反而更难解释。录音只落本地
// 数据目录，受 voiceRecordingRetention 的三重上限管辖，不做任何自动上传。
//
// 格式选 WAV 不选裸 PCM：验收判据要求「能播、能听出内容」，裸 .pcm 双击打不开。
// 头 44 字节手写，不引依赖。
// ============================================================================

import fs from 'fs';
import path from 'path';
import {
  VOICE_DOWNSTREAM_SAMPLE_RATE,
  VOICE_RECORDING_DIR_NAME,
  VOICE_RECORDING_DOWNSTREAM_FILE,
  VOICE_RECORDING_META_FILE,
  VOICE_RECORDING_UPSTREAM_FILE,
  VOICE_UPSTREAM_SAMPLE_RATE,
} from '../../../shared/constants/voice';
import { getUserDataPath } from '../../platform/appPaths';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceCallRecorder');

const WAV_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
/** RIFF chunkSize 字段（= 36 + dataSize）与 data 子块 size 字段的写入偏移。 */
const RIFF_SIZE_OFFSET = 4;
const DATA_SIZE_OFFSET = 40;

/**
 * 录音开关判据。**默认关**：只认字面 `true`，undefined / 缺配置 / 任何其他值都是关。
 *
 * 单列成一个谓词是为了把这条钉住：紧邻的声纹开关用的是 `voiceprint !== false`
 * （默认开），两者形状相反，照着旁边那行抄一次就会变成「默认给所有人录音」。
 */
export function isVoiceCallRecordingEnabled(live: { recordCalls?: boolean } | undefined): boolean {
  return live?.recordCalls === true;
}

/** 录音根目录。测试可传 root 覆盖，生产读数据目录。 */
export function getVoiceRecordingRoot(root?: string): string {
  return root ?? path.join(getUserDataPath(), VOICE_RECORDING_DIR_NAME);
}

/** 44 字节 PCM WAV 头；长度字段先写 0，close 时回填真实值。 */
function buildWavHeader(sampleRate: number, dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = sampleRate * CHANNELS * (BITS_PER_SAMPLE / 8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, RIFF_SIZE_OFFSET);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt 子块长度
  header.writeUInt16LE(1, 20); // audioFormat = 1 (PCM)
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32); // blockAlign
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, DATA_SIZE_OFFSET);
  return header;
}

/** 一路 WAV：建流时先占位写头，收尾时回填两个长度字段。 */
class WavTrack {
  private readonly stream: fs.WriteStream;
  private bytes = 0;
  private broken = false;

  constructor(private readonly filePath: string, private readonly sampleRate: number) {
    this.stream = fs.createWriteStream(filePath);
    // 写流出错不能把整通电话带崩：标记这一路失效并留痕，通话本身继续。
    this.stream.on('error', (error) => {
      this.broken = true;
      logger.warn('recording track write failed', { filePath, error: error.message });
    });
    this.stream.write(buildWavHeader(sampleRate, 0));
  }

  write(pcm: Buffer): void {
    if (this.broken || pcm.length === 0) return;
    this.bytes += pcm.length;
    this.stream.write(pcm);
  }

  /** 关流后回填长度。返回音频数据字节数（不含 44 字节头）。 */
  async finalize(): Promise<number> {
    await new Promise<void>((resolve) => this.stream.end(resolve));
    if (this.broken) return this.bytes;
    try {
      const handle = await fs.promises.open(this.filePath, 'r+');
      try {
        const sizes = buildWavHeader(this.sampleRate, this.bytes);
        await handle.write(sizes.subarray(RIFF_SIZE_OFFSET, RIFF_SIZE_OFFSET + 4), 0, 4, RIFF_SIZE_OFFSET);
        await handle.write(sizes.subarray(DATA_SIZE_OFFSET, DATA_SIZE_OFFSET + 4), 0, 4, DATA_SIZE_OFFSET);
      } finally {
        await handle.close();
      }
    } catch (error) {
      // 头没回填 = 播放器读到 dataSize 0。留痕，别让「文件在但播不出」无从判因。
      logger.warn('recording header finalize failed', {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.bytes;
  }
}

export interface VoiceCallRecordingMeta {
  voiceSessionId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  upstreamBytes: number;
  downstreamBytes: number;
  upstreamSampleRate: number;
  downstreamSampleRate: number;
}

export interface VoiceCallRecorder {
  /** 本通电话的录音目录（绝对路径）。 */
  readonly dir: string;
  /** 上行麦克风帧（PCM16@16k）。 */
  feedUpstream(pcm: Buffer): void;
  /** 下行助手播报帧（PCM16@24k）。 */
  feedDownstream(pcm: Buffer): void;
  /** 收尾：关两路流、回填 WAV 头、写 meta.json。重复调用是 no-op。 */
  close(endedAt?: number): Promise<VoiceCallRecordingMeta | null>;
}

export interface CreateVoiceCallRecorderOptions {
  /** 录音根目录覆盖（测试用）。 */
  root?: string;
  /** 起始时间覆盖（测试用）。 */
  now?: number;
}

/** 目录名带时间戳前缀，按字典序即按时间序——retention 排最旧不用再 stat 每个目录。 */
function callDirName(startedAt: number, voiceSessionId: string): string {
  const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const safeId = voiceSessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return `${stamp}-${safeId}`;
}

/**
 * 建一通电话的 recorder。**只在开关已判为开时调用**——本函数不读配置，
 * 闸在调用方（拨号那一刻）判一次。
 *
 * 建目录失败返回 null（通话照打，不因录不了而挂断），但一定 warn 出可区分的原因：
 * fail-open 说的是行为不变，不是失败不留痕。
 */
export function createVoiceCallRecorder(
  voiceSessionId: string,
  options: CreateVoiceCallRecorderOptions = {},
): VoiceCallRecorder | null {
  const startedAt = options.now ?? Date.now();
  const dir = path.join(getVoiceRecordingRoot(options.root), callDirName(startedAt, voiceSessionId));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    logger.warn('recording directory create failed; call proceeds without recording', {
      voiceSessionId,
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const upstream = new WavTrack(path.join(dir, VOICE_RECORDING_UPSTREAM_FILE), VOICE_UPSTREAM_SAMPLE_RATE);
  const downstream = new WavTrack(path.join(dir, VOICE_RECORDING_DOWNSTREAM_FILE), VOICE_DOWNSTREAM_SAMPLE_RATE);
  let closed = false;
  logger.info('call recording started', { voiceSessionId, dir });

  return {
    dir,
    feedUpstream: (pcm) => { if (!closed) upstream.write(pcm); },
    feedDownstream: (pcm) => { if (!closed) downstream.write(pcm); },
    close: async (endedAtOverride?: number) => {
      if (closed) return null;
      closed = true;
      const endedAt = endedAtOverride ?? Date.now();
      const [upstreamBytes, downstreamBytes] = await Promise.all([upstream.finalize(), downstream.finalize()]);
      const meta: VoiceCallRecordingMeta = {
        voiceSessionId,
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        upstreamBytes,
        downstreamBytes,
        upstreamSampleRate: VOICE_UPSTREAM_SAMPLE_RATE,
        downstreamSampleRate: VOICE_DOWNSTREAM_SAMPLE_RATE,
      };
      try {
        await fs.promises.writeFile(path.join(dir, VOICE_RECORDING_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
      } catch (error) {
        logger.warn('recording meta write failed', {
          dir, error: error instanceof Error ? error.message : String(error),
        });
      }
      logger.info('call recording finished', {
        voiceSessionId, dir, upstreamBytes, downstreamBytes, durationMs: meta.durationMs,
      });
      return meta;
    },
  };
}

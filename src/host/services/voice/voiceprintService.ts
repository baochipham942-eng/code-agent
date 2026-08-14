// ============================================================================
// 声纹能力的通话外壳与设置面入口（N-L7-SPK）
//
// voiceSessionService 只拿三个小钩子（prepare / activate / release），声纹的
// 生命周期、IPC 面（状态/注册/清除/备模型）全在这里——那边贴着 god-file 门。
//
// 合规承重见 voiceprintStore.ts 头注（含「绝不当认证用」的三层证据）。
// ============================================================================

import { createLogger } from '../infra/logger';
import {
  createSpeakerEmbedder,
  downloadVoiceprintModel,
  getVoiceprintRuntimeStatus,
  type SpeakerEmbedder,
  type VoiceprintRuntimeStatus,
} from './speakerEmbedding';
import { createSpeakerIdentityTracker, type SpeakerIdentityTracker } from './speakerIdentity';
import {
  clearVoiceprint,
  getVoiceprintStatus,
  loadOwnerEmbeddings,
  registerOwnerEmbedding,
  touchOwnerMatched,
  type VoiceprintStatus,
} from './voiceprintStore';
import { VOICEPRINT_MAX_OWNER_EMBEDDINGS } from '../../../shared/constants/voice';
import type { VoiceContinuityContext } from './voiceContextAssembler';

const logger = createLogger('VoiceprintService');

/** 全内存，随通话 teardown 释放（§4.3 临时锚定不落盘不建档）。 */
export interface VoiceprintCallState {
  tracker: SpeakerIdentityTracker | null;
  embedder: SpeakerEmbedder | null;
  /** 已注册本人时扣住的个性化上下文，认出本人才交还给通话（B4/B5）。 */
  heldContinuity: VoiceContinuityContext | null;
}

/** 设置页「在通话中注册」要摸到当前通话的 tracker；一条全局单路通话，一个槽位够了。 */
let activeTracker: SpeakerIdentityTracker | null = null;

export interface VoiceprintCallSetup {
  /** 已注册本人声纹 → 拨号时不直挂 continuity，等声纹认出本人再挂。 */
  withholdContinuity: boolean;
  initialState(continuity: VoiceContinuityContext | null): VoiceprintCallState;
  /**
   * embedder（模型加载 186ms，与上游建连并行）就绪后把 tracker 挂进 state。
   * embedder=null（模型/运行时缺失、开关关）= 整条声纹链路静默跳过。
   */
  activate(hooks: {
    state: VoiceprintCallState;
    isCurrent(): boolean;
    /** 认出本人时把扣住的 continuity 交还通话（内部已回写 lastMatchedAt）。 */
    attachContinuity(continuity: VoiceContinuityContext): void;
  }): void;
}

export function prepareVoiceprintForCall(enabled: boolean): VoiceprintCallSetup {
  const ownerEmbeddings = enabled ? loadOwnerEmbeddings() : [];
  const embedderPromise: Promise<SpeakerEmbedder | null> = enabled
    ? createSpeakerEmbedder().catch(() => null)
    : Promise.resolve(null);
  const withholdContinuity = ownerEmbeddings.length > 0;
  return {
    withholdContinuity,
    initialState: (continuity) => ({
      tracker: null,
      embedder: null,
      heldContinuity: withholdContinuity ? continuity : null,
    }),
    activate({ state, isCurrent, attachContinuity }) {
      void embedderPromise.then((embedder) => {
        if (!embedder) return;
        if (!isCurrent()) {
          embedder.dispose();
          return;
        }
        state.embedder = embedder;
        state.tracker = createSpeakerIdentityTracker({
          ownerEmbeddings,
          embed: (pcm) => embedder.embedPcm(pcm),
          onOwnerRecognized: () => {
            if (!isCurrent()) return;
            // 只回写命中时间戳（保留期顺延），不写向量。
            touchOwnerMatched();
            const held = state.heldContinuity;
            if (held) {
              state.heldContinuity = null;
              attachContinuity(held);
              logger.info('voiceprint owner recognized, continuity attached');
            }
          },
        });
        activeTracker = state.tracker;
        logger.info('voiceprint tracker ready', { ownerRegistered: ownerEmbeddings.length > 0 });
      });
    },
  };
}

export function releaseVoiceprintForCall(state: VoiceprintCallState): void {
  if (state.tracker && state.tracker === activeTracker) activeTracker = null;
  state.tracker = null;
  state.embedder?.dispose();
  state.embedder = null;
  state.heldContinuity = null;
}

// ── 设置页 IPC 面 ──────────────────────────────────────────────────────

export interface VoiceprintOverview {
  status: VoiceprintStatus;
  runtime: VoiceprintRuntimeStatus;
  /** 当前有没有一通声纹链路就绪的通话（决定「注册」按钮可不可点）。 */
  callActive: boolean;
}

export function getVoiceprintOverview(): VoiceprintOverview {
  return {
    status: getVoiceprintStatus(),
    runtime: getVoiceprintRuntimeStatus(),
    callActive: activeTracker !== null,
  };
}

export type VoiceprintRegisterResult =
  | { ok: true; overview: VoiceprintOverview }
  | { ok: false; reason: 'no_active_call' | 'no_samples' };

/**
 * 显式注册（用户在设置页点「这是我」）：取当前通话主说话人聚类的样本入库。
 * 注册是显式动作，这里是唯一入口——没有任何路径「用着用着悄悄注册」。
 */
export function registerVoiceprintFromActiveCall(): VoiceprintRegisterResult {
  if (!activeTracker) return { ok: false, reason: 'no_active_call' };
  const samples = activeTracker.collectOwnerSamples(VOICEPRINT_MAX_OWNER_EMBEDDINGS);
  if (!samples.length) return { ok: false, reason: 'no_samples' };
  for (const sample of samples) registerOwnerEmbedding(sample);
  logger.info('voiceprint registered from active call', { samples: samples.length });
  return { ok: true, overview: getVoiceprintOverview() };
}

/** 一键清除：删除整个声纹目录（模型缓存不动——那是组件不是身份数据）。 */
export function clearVoiceprintData(): VoiceprintOverview {
  clearVoiceprint();
  return getVoiceprintOverview();
}

/** 设置页「下载声纹组件」。 */
export async function prepareVoiceprintModel(): Promise<VoiceprintOverview> {
  await downloadVoiceprintModel();
  return getVoiceprintOverview();
}

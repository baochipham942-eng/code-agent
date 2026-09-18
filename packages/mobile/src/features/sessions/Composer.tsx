import { useEffect, useRef, useState } from 'react';
import type { PlatformPorts } from '../../platform/ports';
import type { messages } from '../../i18n';
import { AppIcon } from '../../app/AppIcon';
import { StatusSlot, type StatusItem } from '../../app/StatusSlot';
import { useVoiceCapture, VoicePanel } from './VoiceCapture';
import type { DictationPort } from './VoiceCapture';
import { classifyVoiceFailure, voiceFailureAction, voiceFailureMessage } from './voiceFailure';
import type { CompanionTranscriptionReadiness } from '../../../../../src/shared/companion/lanProtocol';
import type { UploadProgress, VoiceResult } from '../../stores/companionStore';
import { joinTranscript } from '../../stores/mobileStore';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentStatus(text: ReturnType<typeof messages>, item: UploadProgress): string {
  if (item.phase === 'preparing') return text.attachPreparing;
  if (item.phase === 'transferring') return `${text.attachTransferring} · ${formatBytes(item.sentBytes)} / ${formatBytes(item.totalBytes)}`;
  if (item.phase === 'complete') return text.attachComplete;
  if (item.error === 'UPLOAD_TOO_LARGE') return text.uploadTooLarge;
  if (item.error === 'COMPANION_FILE_TYPE_DENIED') return text.fileTypeDenied;
  return text.attachFailed;
}

/**
 * 输入区。布局契约是设计稿 design.html 的 composer()：
 * 工具行左簇 `[添加材料][模型 ⌄]`、弹性空隙、右簇 `[麦克风][发送]`；录音时整块换成语音面板。
 * 从 MobileRoot 里拆出来，是因为「录音面板替换输入框」需要一个稳定的宿主，
 * 顺带让 tests/unit/mobile/composer.test.tsx 能直接钉这份布局。
 */
export function Composer({
  text, draft, editDraft, offline, sendDisabled, send, running, modelLabel, openModel, openSettings,
  attach, attachDisabled, attachments, retryAttachment, removeAttachment,
  recorder, transcribe, discardPendingTranscript, commitSpoken, dictation, voiceDisabled, voicePending, voiceResult, voiceReady, onVoiceState, status = [],
  transcription, dictationTranscription, openVoiceSetup, skipTranscriptionPreflight, onSkipTranscriptionPreflight,
}: {
  text: ReturnType<typeof messages>;
  draft: string;
  editDraft(value: string): void;
  /** 未连接电脑：占位文案改成「先写下来，连接后再发送…」，输入框本身照常可写。 */
  offline: boolean;
  sendDisabled: boolean;
  send(): void;
  /**
   * 这条会话正在跑的那次执行（null = 没在跑）。有它且草稿为空时，右下角那个键**就是停止**
   * ——照桌面 SendButton 的三态（空闲=发送 / 处理中+无内容=停止 / 处理中+有内容=发送）。
   * 爸 2026-09-16 build 43 真机：「为什么要展示 1 个停止任务的按钮？发送按钮就是停止呀」。
   */
  running?: { stop(): void; stopDisabled: boolean } | null;
  modelLabel: string | null;
  openModel(): void;
  /** 打开系统设置里本 App 那一页（麦克风开关在那里）。 */
  openSettings?(): void;
  attach?: () => void;
  attachDisabled: boolean;
  attachments?: UploadProgress[];
  retryAttachment?(id: string): void;
  removeAttachment?(id: string): void;
  recorder: PlatformPorts['recorder'];
  transcribe(audio: { audioData: string; mimeType: string; durationMs: number }, continuation: boolean, take: string): Promise<string | null>;
  discardPendingTranscript(take: string): void;
  commitSpoken?(text: string, continuation: boolean, take: string, sentenceId: number): Promise<void>;
  dictation?: DictationPort;
  voiceDisabled: boolean;
  voicePending: boolean;
  /** 最近一条转写命令的结果，带 commandId 与真实错误码。 */
  voiceResult: VoiceResult | null;
  /** 此刻发得出转写命令吗——发不出时录音面板要收尾，不能把输入框锁在后面。 */
  voiceReady: boolean;
  /** 上报输入区自己的状态：录音中（禁横滑）、以及「转写失败正由我显示」（通用提示条据此让位）。 */
  onVoiceState(state: { recording: boolean; failed: boolean }): void;
  /** 输入框上方唯一状态位里 MobileRoot 那几条候选；语音失败由这里补进去，按 rank 只露最急的一条。 */
  status?: StatusItem[];
  transcription?: CompanionTranscriptionReadiness;
  /** 实时听写（百炼密钥）的就绪三态；旧宿主不报——预检按未知处理，不因缺它拦实时听写。 */
  dictationTranscription?: CompanionTranscriptionReadiness;
  openVoiceSetup?(): void;
  /** 「开好了，再试一次」之后下一次点麦克风跳过本地三态预判，交给宿主判定。 */
  skipTranscriptionPreflight?: boolean;
  onSkipTranscriptionPreflight?(): void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const skipPreflight = useRef(false);
  skipPreflight.current = !!skipTranscriptionPreflight;
  /**
   * 这次录音开始前草稿已经有多长——面板里的「识别文字」只显示这之后追加的部分。
   * 直接把整条 draft 显示出去的话，用户录音前自己打的字会出现在识别区，
   * 看起来像是刚刚识别出来的（2026-09-13 爸真机推翻了 09-12 我自己定的这个行为）。
   * 面板关着时一直跟着草稿走，面板一开就冻住——录音期间输入框不在场，草稿只会被转写追加。
   */
  const spokenFrom = useRef(0);
  const voice = useVoiceCapture({ recorder, pending: voicePending, result: voiceResult, ready: voiceReady, transcribe, discardPending: discardPendingTranscript, dictation, commitSpoken,
    preflight: () => {
      if (skipPreflight.current) {
        skipPreflight.current = false;
        onSkipTranscriptionPreflight?.();
        return null;
      }
      if (transcription === 'not-installed') return { stage: 'transcribe', reason: 'COMPANION_TRANSCRIPTION_UNAVAILABLE' };
      if (transcription === 'no-key') {
        // 分段转写没密钥不等于不能语音输入：将走实时听写（百炼密钥，手机有 PCM 录音口且宿主广告了
        // dictation）就放行——两条路各用各的密钥，只看 Groq 会把只配百炼的电脑拦死（ai-review Important）。
        // 旧宿主不报 dictationTranscription：按未知处理，维持「实时听写本就能用」的旧行为。
        const dictationUsable = dictation?.available === true && !!recorder?.startPcm
          && dictationTranscription !== 'no-key' && dictationTranscription !== 'not-installed';
        if (!dictationUsable) return { stage: 'transcribe', reason: 'SPEECH_NO_CHANNEL' };
      }
      return null;
    } });
  useEffect(() => {
    const input = textarea.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }
  }, [draft, voice.panelOpen]);
  // 录音中不让横滑离开主会话（design.md §5 手势表）；失败在不在场也要上报，
  // 否则通用提示条让位之后，转写失败可能一个落点都没有（grok ai-review Nit）。
  useEffect(() => { onVoiceState({ recording: voice.panelOpen, failed: !!voice.failure }); },
    [voice.panelOpen, voice.failure, onVoiceState]);
  useEffect(() => { if (!voice.panelOpen) spokenFrom.current = draft.length; }, [voice.panelOpen, draft]);
  /**
   * 麦克风被通话/会议占着（N-MOBILE-VOICE-ERRCODE-LEAK，爸 2026-09-16 拍板真检测）：原生侧盯着音频会话，
   * 占用方一放手就回调，这里把提示从「被占用」翻成「空出来了」，并给「继续录音」。不自动开录——
   * 没经用户点按就开麦克风不行。没有这个口的平台（安卓厂商插件）只剩「结束后再试」手动一档。
   */
  const [micReleased, setMicReleased] = useState(false);
  const busy = voice.failure?.reason === 'MICROPHONE_BUSY';
  useEffect(() => {
    setMicReleased(false);
    if (!busy || !recorder?.watchMicrophoneRelease) return;
    return recorder.watchMicrophoneRelease(() => setMicReleased(true));
  }, [busy, recorder]);
  const kind = voice.failure
    ? classifyVoiceFailure(voice.failure.reason, voice.failure.stage, voice.failure.partial)
    : null;
  // 用户面不出现内部错误码：reason 只进 data-reason 供取证（build 45 真机「录音失败 · FAILED_TO_RECORD」）。
  const notice = !voice.failure || !kind ? null
    : busy && micReleased ? text.microphoneReleased
    : voiceFailureMessage(text, kind);
  const noticeAction = !kind || !voice.failure ? undefined
    : voiceFailureAction(text, kind, {
      retry: voice.retry, openSettings, openVoiceSetup, micReleased,
    });
  return <>
    <StatusSlot items={[...status, notice ? { rank: 4, message: notice, action: noticeAction, reason: voice.failure?.reason } : null]} />
    <div className={voice.panelOpen ? 'composer voice-composer' : 'composer'}>
      {voice.panelOpen
        ? <VoicePanel text={text} phase={voice.phase} pending={voicePending} elapsedMs={voice.elapsedMs}
          transcript={voice.degraded
            ? draft.slice(spokenFrom.current).trimStart()
            : voice.spoken || joinTranscript(draft.slice(spokenFrom.current).trimStart(), voice.partial, true)}
          dropped={voice.dropped} degraded={voice.degraded}
          stop={voice.stop} cancel={voice.cancel} />
        : <>
          {attachments?.map(item => {
            const canRetry = item.phase === 'failed' && item.retryable === true;
            const canRemove = item.phase === 'failed' || item.phase === 'complete';
            return <div key={item.id} className="attachment" data-testid="attachment-chip" data-phase={item.phase}>
              <AppIcon name="file" />
              <div className="flex">
                <div data-testid="attachment-name">{item.name}</div>
                <div className="small" role="status">{attachmentStatus(text, item)}</div>
                {item.phase === 'transferring' && <div className="progress-track" data-testid="attachment-progress">
                  <span style={{ width: `${item.totalBytes ? Math.round((item.sentBytes / item.totalBytes) * 100) : 0}%` }} />
                </div>}
              </div>
              <div className="attachment-actions">
                {canRetry && <button type="button" aria-label={text.attachRetry} onClick={() => retryAttachment?.(item.id)}>{text.attachRetry}</button>}
                {canRemove && <button type="button" aria-label={text.attachRemove} onClick={() => removeAttachment?.(item.id)}><AppIcon name="close" /></button>}
              </div>
            </div>;
          })}
          <textarea ref={textarea} aria-label={text.draft} placeholder={offline ? text.offlinePlaceholder : text.placeholder} rows={1}
            value={draft} data-testid="draft"
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onChange={event => { if (voice.failure) voice.dismissFailure(); editDraft(event.target.value); }} />
          <div className="composer-tools">
            {attach && <button aria-label={text.attach} disabled={attachDisabled} onClick={attach}><AppIcon name="plus" /></button>}
            {modelLabel && <button className="model" aria-label={`${text.model} · ${modelLabel}`} onClick={openModel}>
              <span className="model-name">{modelLabel}</span><AppIcon name="down" /></button>}
            <span className="spacer" />
            {recorder && <button aria-label={text.voice} disabled={voiceDisabled} onClick={() => void voice.start()}><AppIcon name="mic" /></button>}
            {running && !draft.trim()
              ? <button className="send stop" aria-label={text.stop} data-testid="send-stop" disabled={running.stopDisabled}
                onClick={running.stop}><AppIcon name="stop" /></button>
              : <button className="send" aria-label={text.send} data-testid="send" disabled={sendDisabled}
                onClick={() => { if (!composing.current) send(); }}><AppIcon name="arrow" /></button>}
          </div>
        </>}
    </div>
  </>;
}

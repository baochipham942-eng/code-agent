import { useEffect, useRef } from 'react';
import type { PlatformPorts } from '../../platform/ports';
import type { messages } from '../../i18n';
import { AppIcon } from '../../app/AppIcon';
import { useVoiceCapture, VoicePanel } from './VoiceCapture';

/**
 * 输入区。布局契约是设计稿 design.html 的 composer()：
 * 工具行左簇 `[添加材料][模型 ⌄]`、弹性空隙、右簇 `[麦克风][发送]`；录音时整块换成语音面板。
 * 从 MobileRoot 里拆出来，是因为「录音面板替换输入框」需要一个稳定的宿主，
 * 顺带让 tests/unit/mobile/composer.test.tsx 能直接钉这份布局。
 */
export function Composer({
  text, draft, editDraft, offline, sendDisabled, send, modelLabel, openModel,
  attach, attachDisabled, recorder, transcribe, voiceDisabled, voicePending, voiceOutcome, voiceErrorCode, onVoiceState,
}: {
  text: ReturnType<typeof messages>;
  draft: string;
  editDraft(value: string): void;
  /** 未连接电脑：占位文案改成「先写下来，连接后再发送…」，输入框本身照常可写。 */
  offline: boolean;
  sendDisabled: boolean;
  send(): void;
  modelLabel: string | null;
  openModel(): void;
  attach?: () => void;
  attachDisabled: boolean;
  recorder: PlatformPorts['recorder'];
  transcribe(audio: { audioData: string; mimeType: string; durationMs: number }): Promise<void>;
  voiceDisabled: boolean;
  voicePending: boolean;
  voiceOutcome: 'done' | 'error' | null;
  /** 最近一条命令被拒的真实错误码，转写失败时要带上它才定位得了。 */
  voiceErrorCode: string | null;
  /** 上报输入区自己的状态：录音中（禁横滑）、以及「转写失败正由我显示」（通用提示条据此让位）。 */
  onVoiceState(state: { recording: boolean; failed: boolean }): void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const voice = useVoiceCapture({ recorder, pending: voicePending, outcome: voiceOutcome, errorCode: voiceErrorCode, transcribe });
  useEffect(() => {
    const input = textarea.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }
  }, [draft, voice.panelOpen]);
  // 录音中不让横滑离开主会话（design.md §5 手势表）；失败在不在场也要上报，
  // 否则通用提示条让位之后，转写失败可能一个落点都没有。
  useEffect(() => { onVoiceState({ recording: voice.panelOpen, failed: !!voice.failure }); },
    [voice.panelOpen, voice.failure, onVoiceState]);
  const notice = voice.failure?.reason === 'MICROPHONE_DENIED' ? text.microphoneDenied
    : voice.failure ? `${voice.failure.stage === 'record' ? text.voiceRecordFailed : text.voiceTranscribeFailed} · ${voice.failure.reason}`
    : null;
  return <>
    {notice && <p className="notice voice-notice" role="status">{notice}<button onClick={voice.retry}>{text.retry}</button></p>}
    {/* 转写回填后回到普通编辑态：说明可以改完再发，不自动提交（design.html voiceReview）。 */}
    {!voice.panelOpen && voiceOutcome === 'done' && draft.trim() && <div className="compose-hint">{text.voiceReviewHint}</div>}
    <div className={voice.panelOpen ? 'composer voice-composer' : 'composer'}>
      {voice.panelOpen
        ? <VoicePanel text={text} phase={voice.phase} pending={voicePending} elapsedMs={voice.elapsedMs} transcript={draft}
          stop={voice.stop} cancel={voice.cancel} />
        : <>
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
            <button className="send" aria-label={text.send} data-testid="send" disabled={sendDisabled}
              onClick={() => { if (!composing.current) send(); }}><AppIcon name="arrow" /></button>
          </div>
        </>}
    </div>
  </>;
}

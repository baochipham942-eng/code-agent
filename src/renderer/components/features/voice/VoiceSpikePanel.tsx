// ============================================================================
// Phase 0 spike 的 dev-only 通话面板
//
// 入口靠 localStorage 开关（VOICE_DEV_FLAG_KEY），不进正式 UI、不进设置页。
// Phase 1 落 VoiceChrome 时整个文件删掉。
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { VOICE_STREAM_WS_PATH } from '@shared/constants';
import type { VoiceEvent } from '@shared/contract/voice';
import { useRealtimeVoiceAudio } from '../../../hooks/useRealtimeVoiceAudio';
import { useSessionStore } from '../../../stores/sessionStore';

type CallState = 'idle' | 'connecting' | 'live' | 'error';

function hasToken(): boolean {
  return typeof (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ === 'string';
}

function buildStreamUrl(sessionId: string): string {
  const token = (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ sessionId });
  if (typeof token === 'string') params.set('token', token);
  return `${scheme}://${window.location.host}${VOICE_STREAM_WS_PATH}?${params.toString()}`;
}

export function VoiceSpikePanel(): React.JSX.Element {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const audio = useRealtimeVoiceAudio();
  const wsRef = useRef<WebSocket | null>(null);
  const [callState, setCallState] = useState<CallState>('idle');
  const [status, setStatus] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [userText, setUserText] = useState('');

  const hangUp = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'end' }));
    wsRef.current?.close();
    wsRef.current = null;
    audio.stop();
    setCallState('idle');
  }, [audio]);

  const dial = useCallback(() => {
    if (!currentSessionId) {
      setStatus('先打开一个会话');
      return;
    }
    setCallState('connecting');
    setStatus('连接中…');
    setAssistantText('');
    setUserText('');

    const ws = new WebSocket(buildStreamUrl(currentSessionId));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      void audio.start((pcm16k) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm16k.buffer as ArrayBuffer);
      });
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        audio.enqueuePlayback(new Int16Array(event.data));
        return;
      }
      const voiceEvent = JSON.parse(String(event.data)) as VoiceEvent;
      switch (voiceEvent.type) {
        case 'state':
          setCallState(voiceEvent.state === 'live' ? 'live' : voiceEvent.state === 'closed' ? 'idle' : 'connecting');
          setStatus(voiceEvent.state);
          break;
        case 'speech.started':
          audio.clearPlayback(); // barge-in：用户开口就掐掉正在播的回答
          setAssistantText('');
          break;
        case 'user.transcript':
          setUserText(voiceEvent.text);
          break;
        case 'assistant.transcript':
          setAssistantText((prev) => (voiceEvent.done ? voiceEvent.text : prev + voiceEvent.text));
          break;
        case 'response.done':
          if (voiceEvent.ttfaMs !== undefined) setStatus(`首包 ${voiceEvent.ttfaMs}ms`);
          break;
        case 'error':
          setCallState('error');
          setStatus(`${voiceEvent.code}: ${voiceEvent.message}`);
          break;
        default:
          break;
      }
    };

    // WebSocket 的 error 事件不带原因，所以自己记住「有没有 open 过」——
    // 没 open 就 close = 握手被拒（多半是 token/路径），这条信息必须显示出来。
    let opened = false;
    ws.addEventListener('open', () => {
      opened = true;
    });
    ws.onerror = () => setCallState('error');
    ws.onclose = () => {
      audio.stop();
      if (!opened) {
        setCallState('error');
        setStatus(`握手失败 ${new URL(buildStreamUrl(currentSessionId)).host}${hasToken() ? '' : '（无 token）'}`);
      } else {
        setCallState('idle');
      }
    };
  }, [audio, currentSessionId]);

  useEffect(() => hangUp, [hangUp]);

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border border-border bg-background/95 p-3 text-xs shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">实时语音 (spike)</span>
        <span className="text-muted-foreground">{status || callState}</span>
      </div>

      {audio.error && <div className="mb-2 text-red-500">麦克风：{audio.error}</div>}

      <div className="mb-2 h-1 w-full rounded bg-muted">
        <div className="h-1 rounded bg-green-500 transition-all" style={{ width: `${Math.min(100, audio.micLevel * 400)}%` }} />
      </div>
      <div className="mb-2 text-muted-foreground">帧 {audio.framesSent}</div>

      {userText && <div className="mb-1 truncate">你：{userText}</div>}
      {assistantText && <div className="mb-2 line-clamp-3">助手：{assistantText}</div>}

      <button
        type="button"
        onClick={callState === 'idle' || callState === 'error' ? dial : hangUp}
        className="w-full rounded bg-primary px-2 py-1 text-primary-foreground"
      >
        {callState === 'idle' || callState === 'error' ? '开始通话' : '挂断'}
      </button>
    </div>
  );
}

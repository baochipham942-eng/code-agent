// ============================================================================
// useVoiceInput - 语音输入 Hook
// 使用 MediaRecorder 录音，通过 IPC 调用主进程 Groq Whisper 转写
// ============================================================================

import { useState, useRef, useCallback } from 'react';
import { createLogger } from '../utils/logger';

const logger = createLogger('VoiceInput');

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing' | 'error';

interface UseVoiceInputOptions {
  /** 转写完成回调 */
  onTranscript?: (text: string) => void;
  /** 最大录音时长（秒），默认 60 */
  maxDuration?: number;
}

interface UseVoiceInputReturn {
  /** 当前状态 */
  status: VoiceInputStatus;
  /** 录音时长（秒） */
  duration: number;
  /** 是否支持语音输入 */
  isSupported: boolean;
  /** 开始录音 */
  start: () => void;
  /** 停止录音 */
  stop: () => void;
  /** 切换录音状态 */
  toggle: () => void;
  /** 错误信息 */
  error: string | null;
}

/**
 * 语音输入 Hook
 *
 * 使用 MediaRecorder API 录音，通过 Electron IPC 调用主进程
 * Groq Whisper API 进行语音转文字
 *
 * @example
 * ```tsx
 * const { status, toggle, duration } = useVoiceInput({
 *   onTranscript: (text) => setMessage(prev => prev + text)
 * });
 * ```
 */
export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const { onTranscript, maxDuration = 60 } = options;

  const [status, setStatus] = useState<VoiceInputStatus>('idle');
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const isStartingRef = useRef(false);

  /**
   * 检测浏览器是否支持录音
   */
  const checkSupport = useCallback(() => {
    if (typeof window === 'undefined') return false;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    if (!window.MediaRecorder) return false;
    // 检查 Electron API 是否可用
    if (!window.electronAPI?.transcribeSpeech) return false;
    return true;
  }, []);

  /**
   * 开始录音
   */
  const start = useCallback(async () => {
    if (isStartingRef.current || status === 'recording' || status === 'transcribing') return;

    if (!checkSupport()) {
      setIsSupported(false);
      setError('您的浏览器不支持语音输入');
      return;
    }

    try {
      isStartingRef.current = true;
      setError(null);

      // 请求麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      setStatus('recording');
      chunksRef.current = [];

      // 选择最佳音频格式
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // 停止所有音轨
        stream.getTracks().forEach(track => track.stop());

        // 清除计时器
        if (durationIntervalRef.current) {
          clearInterval(durationIntervalRef.current);
          durationIntervalRef.current = null;
        }

        const finalDuration = Math.floor((Date.now() - startTimeRef.current) / 1000);

        // 录音太短则跳过
        if (finalDuration < 1 || chunksRef.current.length === 0) {
          console.warn('[VoiceInput] Audio too short, skipping');
          setStatus('idle');
          setDuration(0);
          return;
        }

        // 上传转写
        if (chunksRef.current.length > 0) {
          setStatus('transcribing');
          try {
            const audioBlob = new Blob(chunksRef.current, { type: mimeType });

            // 转换为 Base64
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioData = btoa(
              new Uint8Array(arrayBuffer).reduce(
                (data, byte) => data + String.fromCharCode(byte),
                ''
              )
            );

            logger.debug('Uploading audio', { mimeType, size: audioBlob.size });

            // 调用主进程转写
            const result = await window.electronAPI!.transcribeSpeech(audioData, mimeType);

            if (result.success && result.text) {
              onTranscript?.(result.text);
              setStatus('idle');
            } else {
              throw new Error(result.error || '转写失败');
            }
          } catch (err) {
            console.error('[VoiceInput] Transcription error:', err);
            setError(err instanceof Error ? err.message : '转写失败');
            setStatus('error');
          }
        } else {
          console.warn('[VoiceInput] No audio chunks recorded');
          setStatus('idle');
        }

        setDuration(0);
      };

      mediaRecorder.onerror = (event) => {
        console.error('[VoiceInput] MediaRecorder error:', event);
        setError('录音出错');
        setStatus('error');
      };

      // 开始录音
      mediaRecorder.start(1000); // 每秒收集一次数据
      startTimeRef.current = Date.now();

      // 开始计时
      durationIntervalRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setDuration(elapsed);

        // 超时自动停止
        if (elapsed >= maxDuration) {
          mediaRecorder.stop();
        }
      }, 1000);

    } catch (err) {
      console.error('[VoiceInput] Start error:', err);
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setError('请允许麦克风权限');
      } else {
        setError('无法访问麦克风');
      }
      setStatus('error');
    } finally {
      isStartingRef.current = false;
    }
  }, [checkSupport, maxDuration, onTranscript, status]);

  /**
   * 停止录音
   */
  const stop = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  /**
   * 切换录音状态
   */
  const toggle = useCallback(() => {
    if (isStartingRef.current) return;

    if (status === 'recording') {
      stop();
    } else if (status === 'idle' || status === 'error') {
      start();
    }
    // transcribing 状态下不允许操作
  }, [status, start, stop]);

  return {
    status,
    duration,
    isSupported,
    start,
    stop,
    toggle,
    error,
  };
}

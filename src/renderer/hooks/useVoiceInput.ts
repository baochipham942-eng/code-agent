// ============================================================================
// useVoiceInput - 语音输入 Hook
// 使用 MediaRecorder 录音，通过 IPC 调用主进程统一 ASR 服务转写
// ============================================================================

import { useState, useRef, useCallback, useEffect } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { AppSettings, SpeechInputSettings, SpeechTranscribeResult } from '@shared/contract';
import { DEFAULT_SPEECH_INPUT_SETTINGS, VOICE_INPUT_SETTINGS_UPDATED_EVENT } from '@shared/contract';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';

const logger = createLogger('VoiceInput');

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing' | 'error';

interface UseVoiceInputOptions {
  /** 转写完成回调 */
  onTranscript?: (text: string, result?: SpeechTranscribeResult) => void;
  /** 最大录音时长（秒），默认 60 */
  maxDuration?: number;
}

interface PendingAudio {
  audioData: string;
  mimeType: string;
  durationSeconds: number;
}

interface UseVoiceInputReturn {
  /** 当前状态 */
  status: VoiceInputStatus;
  /** 录音时长（秒） */
  duration: number;
  /** 是否支持语音输入 */
  isSupported: boolean;
  /** 语音输入是否启用 */
  isEnabled: boolean;
  /** 当前语音输入设置 */
  settings: SpeechInputSettings;
  /** 开始录音 */
  start: () => void;
  /** 停止录音 */
  stop: () => void;
  /** 重试上一段录音 */
  retry: () => void;
  /** 是否可重试上一段录音 */
  canRetry: boolean;
  /** 切换录音状态 */
  toggle: () => void;
  /** 清除错误 */
  clearError: () => void;
  /** 错误信息 */
  error: string | null;
  /** 结构化错误码 */
  errorCode: string | null;
  /** 最近一次转写结果 */
  lastResult: SpeechTranscribeResult | null;
  /** 当前输入音量，0-1 */
  inputLevel: number;
  /** 是否长时间没有检测到明显语音 */
  silenceWarning: boolean;
}

type WindowWithWebkitAudio = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

function mergeSpeechSettings(value?: Partial<SpeechInputSettings>): SpeechInputSettings {
  return {
    ...DEFAULT_SPEECH_INPUT_SETTINGS,
    ...(value ?? {}),
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * 语音输入 Hook
 *
 * 使用 MediaRecorder API 录音，通过桌面桥调用主进程统一 ASR 服务进行语音转文字。
 *
 * @example
 * ```tsx
 * const { status, toggle, duration } = useVoiceInput({
 *   onTranscript: (text) => setMessage(prev => prev + text)
 * });
 * ```
 */
export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const { onTranscript, maxDuration } = options;

  const [status, setStatus] = useState<VoiceInputStatus>('idle');
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  const [settings, setSettings] = useState<SpeechInputSettings>(DEFAULT_SPEECH_INPUT_SETTINGS);
  const [lastResult, setLastResult] = useState<SpeechTranscribeResult | null>(null);
  const [inputLevel, setInputLevel] = useState(0);
  const [silenceWarning, setSilenceWarning] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const levelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const startTimeRef = useRef<number>(0);
  const lastVoiceAtRef = useRef<number>(0);
  const isStartingRef = useRef(false);
  const pendingAudioRef = useRef<PendingAudio | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      try {
        const appSettings = await ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get');
        if (!cancelled) {
          setSettings(mergeSpeechSettings(appSettings.speech));
        }
      } catch (err) {
        logger.warn('Failed to load voice input settings', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    void loadSettings();
    const handleSettingsUpdated = (event: Event) => {
      const next = (event as CustomEvent<Partial<SpeechInputSettings>>).detail;
      setSettings(mergeSpeechSettings(next));
    };
    window.addEventListener(VOICE_INPUT_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(VOICE_INPUT_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
    };
  }, []);

  /**
   * 检测浏览器是否支持录音
   */
  const checkSupport = useCallback(() => {
    if (typeof window === 'undefined') return false;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    if (!window.MediaRecorder) return false;
    // 检查桌面桥 API 是否可用
    if (!ipcService.isAvailable()) return false;
    return true;
  }, []);

  const clearError = useCallback(() => {
    pendingAudioRef.current = null;
    setError(null);
    setErrorCode(null);
    setLastResult(null);
    setStatus('idle');
  }, []);

  const stopLevelMeter = useCallback(() => {
    if (levelIntervalRef.current) {
      clearInterval(levelIntervalRef.current);
      levelIntervalRef.current = null;
    }
    try {
      sourceNodeRef.current?.disconnect();
    } catch {
      // The node can already be disconnected when MediaRecorder tears down.
    }
    sourceNodeRef.current = null;
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch((err) => {
        logger.debug('Failed to close voice input audio context', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    setInputLevel(0);
    setSilenceWarning(false);
  }, []);

  const startLevelMeter = useCallback((stream: MediaStream) => {
    stopLevelMeter();
    const AudioContextCtor = window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      const audioContext = new AudioContextCtor();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      audioContextRef.current = audioContext;
      sourceNodeRef.current = source;
      lastVoiceAtRef.current = Date.now();
      setInputLevel(0);
      setSilenceWarning(false);

      levelIntervalRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let squareSum = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          squareSum += normalized * normalized;
        }
        const rms = Math.sqrt(squareSum / samples.length);
        const level = Math.min(1, rms * 8);
        const now = Date.now();

        setInputLevel(level);
        if (level > 0.08) {
          lastVoiceAtRef.current = now;
        }

        const elapsed = startTimeRef.current ? now - startTimeRef.current : 0;
        setSilenceWarning(elapsed > 2500 && now - lastVoiceAtRef.current > 2000);
      }, 120);
    } catch (err) {
      logger.debug('Voice input level meter unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
      stopLevelMeter();
    }
  }, [stopLevelMeter]);

  const transcribePendingAudio = useCallback(async (pendingAudio: PendingAudio) => {
    setStatus('transcribing');
    setError(null);
    setErrorCode(null);
    setLastResult(null);

    try {
      const result = await ipcService.transcribeSpeech(pendingAudio.audioData, pendingAudio.mimeType, {
        mode: settings.mode,
        language: settings.language,
        model: settings.localModel,
        threads: settings.threads,
        source: 'composer',
        keepAudioOnFailure: settings.preserveAudioOnFailure,
        durationSeconds: pendingAudio.durationSeconds,
      });
      if (!result) throw new Error('转写服务不可用');

      setLastResult(result);
      if (result.success && result.text) {
        pendingAudioRef.current = null;
        onTranscript?.(result.text, result);
        setStatus('idle');
        return;
      }

      if (result.recoverable === false) {
        pendingAudioRef.current = null;
      }
      setErrorCode(result.code ?? null);
      throw new Error(result.error || '转写失败');
    } catch (err) {
      console.error('[VoiceInput] Transcription error:', err);
      setError(err instanceof Error ? err.message : '转写失败');
      setErrorCode((current) => current ?? 'TRANSCRIPTION_FAILED');
      setStatus('error');
    } finally {
      setDuration(0);
    }
  }, [onTranscript, settings.language, settings.localModel, settings.mode, settings.preserveAudioOnFailure, settings.threads]);

  const effectiveMaxDuration = maxDuration ?? settings.maxDurationSeconds;

  /**
   * 开始录音
   */
  const start = useCallback(async () => {
    if (isStartingRef.current || status === 'recording' || status === 'transcribing') return;

    if (!settings.enabled) {
      setError('语音输入已关闭');
      setErrorCode('DISABLED');
      setStatus('error');
      return;
    }

    if (!checkSupport()) {
      setIsSupported(false);
      setError('您的浏览器不支持语音输入');
      setErrorCode('UNSUPPORTED');
      setStatus('error');
      return;
    }

    try {
      isStartingRef.current = true;
      pendingAudioRef.current = null;
      setError(null);
      setErrorCode(null);
      setLastResult(null);

      // 请求麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      setStatus('recording');
      setInputLevel(0);
      setSilenceWarning(false);
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
        stopLevelMeter();
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
          setError('录音时间太短，请说话后再松手');
          setErrorCode('AUDIO_TOO_SHORT');
          setStatus('error');
          setDuration(0);
          return;
        }

        // 上传转写
        if (chunksRef.current.length > 0) {
          setStatus('transcribing');
          try {
            const audioBlob = new Blob(chunksRef.current, { type: mimeType });

            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioData = arrayBufferToBase64(arrayBuffer);
            const pendingAudio = { audioData, mimeType, durationSeconds: finalDuration };
            pendingAudioRef.current = pendingAudio;

            logger.debug('Uploading audio', { mimeType, size: audioBlob.size });
            await transcribePendingAudio(pendingAudio);
          } catch (err) {
            console.error('[VoiceInput] Transcription error:', err);
            setError(err instanceof Error ? err.message : '转写失败');
            setErrorCode((current) => current ?? 'TRANSCRIPTION_FAILED');
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
        stopLevelMeter();
        stream.getTracks().forEach(track => track.stop());
        setError('录音出错');
        setErrorCode('RECORDING_ERROR');
        setStatus('error');
      };

      // 开始录音
      mediaRecorder.start(1000); // 每秒收集一次数据
      startTimeRef.current = Date.now();
      startLevelMeter(stream);

      // 开始计时
      durationIntervalRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setDuration(elapsed);

        // 超时自动停止
        if (elapsed >= effectiveMaxDuration) {
          mediaRecorder.stop();
        }
      }, 1000);

    } catch (err) {
      console.error('[VoiceInput] Start error:', err);
      stopLevelMeter();
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setError('请允许麦克风权限');
        setErrorCode('MICROPHONE_PERMISSION_DENIED');
      } else {
        setError('无法访问麦克风');
        setErrorCode('MICROPHONE_UNAVAILABLE');
      }
      setStatus('error');
    } finally {
      isStartingRef.current = false;
    }
  }, [checkSupport, effectiveMaxDuration, settings.enabled, startLevelMeter, status, stopLevelMeter, transcribePendingAudio]);

  /**
   * 停止录音
   */
  const stop = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  useEffect(() => {
    return () => {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      stopLevelMeter();
    };
  }, [stopLevelMeter]);

  const retry = useCallback(() => {
    if (status === 'recording' || status === 'transcribing') return;
    const pendingAudio = pendingAudioRef.current;
    if (!pendingAudio) return;
    void transcribePendingAudio(pendingAudio);
  }, [status, transcribePendingAudio]);

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
    isEnabled: settings.enabled,
    settings,
    start,
    stop,
    retry,
    canRetry: Boolean(pendingAudioRef.current) && status === 'error',
    toggle,
    clearError,
    error,
    errorCode,
    lastResult,
    inputLevel,
    silenceWarning,
  };
}

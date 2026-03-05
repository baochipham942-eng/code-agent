// ============================================================================
// useMeetingRecorder - 会议录音管理 Hook
// 实时转录 (Web Speech API) + 后端精确转写 (whisper-cpp/Groq) + 纪要生成
// ============================================================================

import { useState, useRef, useCallback, useEffect } from 'react';
import { createLogger } from '../utils/logger';
import { useAppStore } from '../stores/appStore';

const logger = createLogger('MeetingRecorder');

export type MeetingStatus = 'idle' | 'recording' | 'paused' | 'saving' | 'transcribing' | 'transcribed' | 'generating' | 'done' | 'error';

export interface LiveSegment {
  text: string;
  timestamp: number; // seconds since recording start
  isFinal: boolean;
}

export interface MeetingResult {
  filePath: string;
  transcript: string;
  minutes: string;
  duration: number;
  model: string;
}

export interface UseMeetingRecorderReturn {
  status: MeetingStatus;
  duration: number;
  error: string | null;
  result: MeetingResult | null;
  audioLevel: number;
  pauseCount: number;
  liveSegments: LiveSegment[];
  interimText: string;
  asrEngine: string;
  startRecording: () => void;
  stopRecording: () => void;
  pauseRecording: () => void;
  resumeRecording: () => void;
  generateMinutes: () => void;
  skipMinutes: () => void;
  reset: () => void;
}

function generateSessionId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function meetingInvoke(channel: string, data: unknown): Promise<any> {
  const api = window.electronAPI as any;
  if (api?.invoke) {
    return api.invoke(channel, data);
  }
  throw new Error('electronAPI not available');
}

// Check Web Speech API availability
function createSpeechRecognition(): any | null {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  try {
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';
    recognition.maxAlternatives = 1;
    return recognition;
  } catch {
    return null;
  }
}

export function useMeetingRecorder(): UseMeetingRecorderReturn {
  const [status, setStatus] = useState<MeetingStatus>('idle');
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MeetingResult | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [pauseCount, setPauseCount] = useState(0);
  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const [interimText, setInterimText] = useState('');
  const [asrEngine, setAsrEngine] = useState('检测中...');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedBeforePauseRef = useRef(0);
  const lastResumeTimeRef = useRef(0);
  const sessionIdRef = useRef<string>('');
  const mimeTypeRef = useRef<string>('audio/webm');
  const isProcessingRef = useRef(false);

  // Audio analysis refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioLevelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Speech recognition ref
  const recognitionRef = useRef<any>(null);
  const recognitionActiveRef = useRef(false);

  // Live ASR (FunASR) refs
  const liveAsrActiveRef = useRef(false);
  const pendingChunksRef = useRef<Blob[]>([]);
  const liveAsrIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAsrChunkIndexRef = useRef(0);
  const lastAsrTextRef = useRef('');
  const asrBusyRef = useRef(false);
  const transcriptCacheRef = useRef<{ filePath: string; transcript: string; duration: number } | null>(null);

  const { setMeetingStatus, setMeetingDuration } = useAppStore();

  // Detect ASR engine on mount via IPC
  useEffect(() => {
    meetingInvoke('meeting:check-asr-engines', {}).then((result: any) => {
      if (!result?.engines) {
        setAsrEngine('检测失败');
        return;
      }
      const engines = result.engines as { name: string; available: boolean }[];
      const funasr = engines.find(e => e.name === 'FunASR');
      const whisper = engines.find(e => e.name === 'whisper-cpp');
      const groq = engines.find(e => e.name === 'Groq');

      const parts: string[] = [];
      // Real-time engine
      if (funasr?.available) {
        parts.push('实时: FunASR Paraformer-zh (本地)');
      }
      // Precise engine
      const precise: string[] = [];
      if (funasr?.available) precise.push('FunASR');
      if (whisper?.available) precise.push('whisper-cpp');
      if (groq?.available) precise.push('Groq');
      if (precise.length > 0) {
        parts.push(`精确: ${precise.join(' / ')}`);
      }
      setAsrEngine(parts.join(' | ') || '无可用引擎');
    }).catch(() => {
      setAsrEngine('检测失败');
    });
  }, []);

  // Sync status to appStore
  useEffect(() => {
    const appStatus = (status === 'saving' || status === 'transcribing' || status === 'generating' || status === 'transcribed')
      ? 'processing' as const
      : status === 'error'
        ? 'idle' as const
        : status as 'idle' | 'recording' | 'paused' | 'done';
    setMeetingStatus(appStatus);
  }, [status, setMeetingStatus]);

  useEffect(() => {
    setMeetingDuration(duration);
  }, [duration, setMeetingDuration]);

  // ── Audio Analysis ──

  const stopAudioAnalysis = useCallback(() => {
    if (audioLevelIntervalRef.current) {
      clearInterval(audioLevelIntervalRef.current);
      audioLevelIntervalRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevel(0);
  }, []);

  const startAudioAnalysis = useCallback((stream: MediaStream) => {
    try {
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      audioLevelIntervalRef.current = setInterval(() => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length) / 255;
        setAudioLevel(rms);
      }, 100);
    } catch (err) {
      logger.warn('Audio analysis not available:', err as Record<string, unknown>);
    }
  }, []);

  // ── Speech Recognition (Real-time) ──

  const stopSpeechRecognition = useCallback(() => {
    if (recognitionRef.current && recognitionActiveRef.current) {
      try {
        recognitionRef.current.stop();
      } catch { /* ignore */ }
      recognitionActiveRef.current = false;
    }
    recognitionRef.current = null;
    setInterimText('');
  }, []);

  const startSpeechRecognition = useCallback(() => {
    const recognition = createSpeechRecognition();
    if (!recognition) {
      logger.info('Web Speech API not available, skipping live transcription');
      return;
    }

    recognitionRef.current = recognition;

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          const elapsed = elapsedBeforePauseRef.current + Math.floor((Date.now() - lastResumeTimeRef.current) / 1000);
          setLiveSegments(prev => [...prev, {
            text: transcript.trim(),
            timestamp: elapsed,
            isFinal: true,
          }]);
        } else {
          interim += transcript;
        }
      }
      setInterimText(interim);
    };

    recognition.onerror = (event: any) => {
      // 'no-speech' and 'aborted' are not real errors
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        logger.warn('Speech recognition error:', { error: event.error });
      }
    };

    recognition.onend = () => {
      // Auto-restart if still recording
      if (recognitionActiveRef.current && recognitionRef.current) {
        try {
          recognitionRef.current.start();
        } catch { /* ignore */ }
      }
    };

    try {
      recognition.start();
      recognitionActiveRef.current = true;
      logger.info('Live speech recognition started');
    } catch (err) {
      logger.warn('Failed to start speech recognition:', err as Record<string, unknown>);
    }
  }, []);

  // ── Live ASR (FunASR persistent process) ──

  const stopLiveAsr = useCallback(() => {
    if (liveAsrIntervalRef.current) {
      clearInterval(liveAsrIntervalRef.current);
      liveAsrIntervalRef.current = null;
    }
    liveAsrActiveRef.current = false;
    pendingChunksRef.current = [];
    meetingInvoke('meeting:live-asr-stop', {}).catch(err => {
      logger.warn('Failed to stop live ASR:', err as Record<string, unknown>);
    });
  }, []);

  const startLiveAsr = useCallback(async () => {
    try {
      const result = await meetingInvoke('meeting:live-asr-start', {});
      if (!result?.success) {
        logger.info('Live ASR unavailable, trying Web Speech API fallback');
        const sr = createSpeechRecognition();
        if (sr) {
          sr.abort?.();
          startSpeechRecognition();
        } else {
          logger.warn('No real-time ASR available (FunASR failed, Web Speech API unavailable)');
          setAsrEngine(prev => prev.replace(/实时: .+?(\s*\||\s*$)/, '实时: 不可用$1'));
        }
        return;
      }

      liveAsrActiveRef.current = true;
      lastAsrChunkIndexRef.current = 0;
      lastAsrTextRef.current = '';
      setAsrEngine('实时: FunASR Paraformer-zh (转录中...)');
      logger.info('Live ASR (FunASR) started');

      liveAsrIntervalRef.current = setInterval(async () => {
        // Prevent concurrent ASR requests
        if (asrBusyRef.current) return;

        // VAD: skip if no speech detected (read analyser directly to avoid stale closure)
        if (analyserRef.current) {
          const buf = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length) / 255;
          if (rms < 0.02) return;
        }

        const allChunks = chunksRef.current;
        if (allChunks.length === 0 || allChunks.length === lastAsrChunkIndexRef.current) return;
        lastAsrChunkIndexRef.current = allChunks.length;
        asrBusyRef.current = true;

        try {
          // Sliding window: header chunk (0) + last 5 chunks (~5s)
          const WINDOW = 5;
          const windowChunks = allChunks.length <= WINDOW + 1
            ? [...allChunks]
            : [allChunks[0], ...allChunks.slice(-WINDOW)];
          const blob = new Blob(windowChunks, { type: mimeTypeRef.current });
          const audioBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const dataUrl = reader.result as string;
              const base64 = dataUrl.split(',')[1] || '';
              resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          const asrResult = await meetingInvoke('meeting:live-asr-chunk', {
            audioBase64,
            mimeType: mimeTypeRef.current,
          });

          if (asrResult?.success && asrResult.text && asrResult.text.trim()) {
            const text = asrResult.text.trim();
            const elapsed = elapsedBeforePauseRef.current +
              Math.floor((Date.now() - lastResumeTimeRef.current) / 1000);
            setLiveSegments(prev => [...prev, {
              text,
              timestamp: elapsed,
              isFinal: true,
            }]);
          }
        } catch (err) {
          logger.warn('Live ASR chunk error:', err as Record<string, unknown>);
        } finally {
          asrBusyRef.current = false;
        }
      }, 1000);

    } catch (err) {
      logger.info('Live ASR start failed, trying Web Speech API fallback:', err as Record<string, unknown>);
      const sr = createSpeechRecognition();
      if (sr) {
        sr.abort?.();
        startSpeechRecognition();
      } else {
        logger.warn('No real-time ASR available');
        setAsrEngine(prev => prev.replace(/实时: .+?(\s*\||\s*$)/, '实时: 不可用$1'));
      }
    }
  }, [startSpeechRecognition]);

  // ── Timer ──

  const stopDurationTimer = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  const startDurationTimer = useCallback(() => {
    stopDurationTimer();
    lastResumeTimeRef.current = Date.now();
    durationIntervalRef.current = setInterval(() => {
      const elapsed = elapsedBeforePauseRef.current + Math.floor((Date.now() - lastResumeTimeRef.current) / 1000);
      setDuration(elapsed);
    }, 1000);
  }, [stopDurationTimer]);

  // ── Cleanup ──

  const cleanup = useCallback(() => {
    stopDurationTimer();
    stopAudioAnalysis();
    stopSpeechRecognition();
    stopLiveAsr();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
  }, [stopDurationTimer, stopAudioAnalysis, stopSpeechRecognition, stopLiveAsr]);

  // ── Process Recording (post-recording pipeline) ──

  const processRecording = useCallback(async (chunks: Blob[], mimeType: string, sessionId: string) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    try {
      const audioBlob = new Blob(chunks, { type: mimeType });
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioData = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          ''
        )
      );

      // Save
      setStatus('saving');
      logger.debug('Saving recording', { size: audioBlob.size, mimeType });
      const saveResult = await meetingInvoke('meeting:save-recording', { audioData, mimeType, sessionId });
      if (!saveResult?.success) throw new Error(saveResult?.error || '保存录音失败');
      const filePath = saveResult.filePath;

      // Transcribe
      setStatus('transcribing');
      logger.debug('Transcribing', { filePath });
      const transcribeResult = await meetingInvoke('meeting:transcribe', { filePath });
      if (!transcribeResult?.success) throw new Error(transcribeResult?.error || '转写失败');
      const transcript = transcribeResult.text;
      const recordingDuration = transcribeResult.duration || 0;
      if (transcribeResult.engine) {
        setAsrEngine(transcribeResult.engine);
      }

      // Save transcript result and pause — let user decide whether to generate minutes
      transcriptCacheRef.current = { filePath, transcript, duration: recordingDuration };
      setResult({
        filePath,
        transcript,
        minutes: '',
        duration: recordingDuration,
        model: '',
      });
      setStatus('transcribed');
      logger.info('Transcription complete, waiting for user action');

    } catch (err) {
      logger.error('Processing error:', err);
      setError(err instanceof Error ? err.message : '处理失败');
      setStatus('error');
    } finally {
      isProcessingRef.current = false;
    }
  }, []);

  // ── Actions ──

  const startRecording = useCallback(async () => {
    if (status === 'recording' || status === 'paused' || isProcessingRef.current) return;

    try {
      setError(null);
      setResult(null);
      setPauseCount(0);
      setLiveSegments([]);
      setInterimText('');
      elapsedBeforePauseRef.current = 0;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      mimeTypeRef.current = mimeType;
      sessionIdRef.current = generateSessionId();
      chunksRef.current = [];

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
          if (liveAsrActiveRef.current) {
            pendingChunksRef.current.push(event.data);
          }
        }
      };

      mediaRecorder.onstop = () => {
        cleanup();
        const chunks = [...chunksRef.current];
        if (chunks.length > 0) {
          processRecording(chunks, mimeTypeRef.current, sessionIdRef.current);
        } else {
          setStatus('idle');
        }
      };

      mediaRecorder.onerror = () => {
        cleanup();
        setError('录音出错');
        setStatus('error');
      };

      mediaRecorder.start(1000);
      setStatus('recording');
      setDuration(0);
      startDurationTimer();
      startAudioAnalysis(stream);
      startLiveAsr();

    } catch (err) {
      cleanup();
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setError('请允许麦克风权限');
      } else {
        setError('无法访问麦克风');
      }
      setStatus('error');
    }
  }, [status, cleanup, processRecording, startDurationTimer, startAudioAnalysis, startLiveAsr]);

  const pauseRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;

    recorder.pause();
    elapsedBeforePauseRef.current += Math.floor((Date.now() - lastResumeTimeRef.current) / 1000);
    stopDurationTimer();
    stopAudioAnalysis();
    // Pause speech recognition
    if (recognitionRef.current && recognitionActiveRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionActiveRef.current = false;
    }
    // Pause live ASR interval
    if (liveAsrIntervalRef.current) {
      clearInterval(liveAsrIntervalRef.current);
      liveAsrIntervalRef.current = null;
    }
    setPauseCount(prev => prev + 1);
    setStatus('paused');
  }, [stopDurationTimer, stopAudioAnalysis]);

  const resumeRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'paused') return;

    recorder.resume();
    startDurationTimer();
    if (streamRef.current) {
      startAudioAnalysis(streamRef.current);
    }
    // Resume live ASR or speech recognition
    if (liveAsrActiveRef.current) {
      // Restart the 3-second interval for live ASR (same logic as startLiveAsr)
      liveAsrIntervalRef.current = setInterval(async () => {
        if (asrBusyRef.current) return;

        if (analyserRef.current) {
          const buf = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length) / 255;
          if (rms < 0.02) return;
        }

        const allChunks = chunksRef.current;
        if (allChunks.length === 0 || allChunks.length === lastAsrChunkIndexRef.current) return;
        lastAsrChunkIndexRef.current = allChunks.length;
        asrBusyRef.current = true;

        try {
          // Sliding window: header chunk (0) + last 5 chunks (~5s)
          const WINDOW = 5;
          const windowChunks = allChunks.length <= WINDOW + 1
            ? [...allChunks]
            : [allChunks[0], ...allChunks.slice(-WINDOW)];
          const blob = new Blob(windowChunks, { type: mimeTypeRef.current });
          const audioBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const dataUrl = reader.result as string;
              const base64 = dataUrl.split(',')[1] || '';
              resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          const asrResult = await meetingInvoke('meeting:live-asr-chunk', {
            audioBase64,
            mimeType: mimeTypeRef.current,
          });

          if (asrResult?.success && asrResult.text && asrResult.text.trim()) {
            const text = asrResult.text.trim();
            const elapsed = elapsedBeforePauseRef.current +
              Math.floor((Date.now() - lastResumeTimeRef.current) / 1000);
            setLiveSegments(prev => [...prev, {
              text,
              timestamp: elapsed,
              isFinal: true,
            }]);
          }
        } catch (err) {
          logger.warn('Live ASR chunk error:', err as Record<string, unknown>);
        } finally {
          asrBusyRef.current = false;
        }
      }, 1000);
    } else {
      startSpeechRecognition();
    }
    setStatus('recording');
  }, [startDurationTimer, startAudioAnalysis, startSpeechRecognition]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recorder.state === 'recording' || recorder.state === 'paused') {
      stopLiveAsr();
      stopSpeechRecognition();
      recorder.stop();
    }
  }, [stopLiveAsr, stopSpeechRecognition]);

  // User chooses to generate minutes after transcription
  const generateMinutes = useCallback(async () => {
    const cache = transcriptCacheRef.current;
    if (!cache) return;

    try {
      setStatus('generating');
      logger.debug('Generating minutes');
      const minutesResult = await meetingInvoke('meeting:generate-minutes', { transcript: cache.transcript });
      if (!minutesResult?.success) throw new Error(minutesResult?.error || '生成会议纪要失败');

      setResult({
        filePath: cache.filePath,
        transcript: cache.transcript,
        minutes: minutesResult.minutes,
        duration: cache.duration,
        model: minutesResult.model || 'unknown',
      });
      setStatus('done');
    } catch (err) {
      logger.error('Minutes generation error:', err);
      setError(err instanceof Error ? err.message : '生成纪要失败');
      setStatus('error');
    }
  }, []);

  // User skips minutes generation, go directly to done with transcript only
  const skipMinutes = useCallback(() => {
    const cache = transcriptCacheRef.current;
    if (!cache) return;

    setResult({
      filePath: cache.filePath,
      transcript: cache.transcript,
      minutes: '',
      duration: cache.duration,
      model: '仅转写',
    });
    setStatus('done');
  }, []);

  const reset = useCallback(() => {
    cleanup();
    setStatus('idle');
    setDuration(0);
    setError(null);
    setResult(null);
    setAudioLevel(0);
    setPauseCount(0);
    setLiveSegments([]);
    setInterimText('');
    elapsedBeforePauseRef.current = 0;
    chunksRef.current = [];
    pendingChunksRef.current = [];
    isProcessingRef.current = false;
    lastAsrChunkIndexRef.current = 0;
    lastAsrTextRef.current = '';
    transcriptCacheRef.current = null;
  }, [cleanup]);

  return {
    status,
    duration,
    error,
    result,
    audioLevel,
    pauseCount,
    liveSegments,
    interimText,
    asrEngine,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    generateMinutes,
    skipMinutes,
    reset,
  };
}

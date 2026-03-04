// ============================================================================
// useMeetingRecorder - 会议录音管理 Hook
// 录音 → 保存 → 转写 → 生成会议纪要
// ============================================================================

import { useState, useRef, useCallback } from 'react';
import { createLogger } from '../utils/logger';

const logger = createLogger('MeetingRecorder');

export type MeetingStatus = 'idle' | 'recording' | 'saving' | 'transcribing' | 'generating' | 'done' | 'error';

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
  startRecording: () => void;
  stopRecording: () => void;
  reset: () => void;
}

function generateSessionId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// 通过 electronAPI.invoke 的类型系统不包含 meeting 通道，使用 any 绕过
function meetingInvoke(channel: string, data: unknown): Promise<any> {
  const api = window.electronAPI as any;
  if (api?.invoke) {
    return api.invoke(channel, data);
  }
  throw new Error('electronAPI not available');
}

export function useMeetingRecorder(): UseMeetingRecorderReturn {
  const [status, setStatus] = useState<MeetingStatus>('idle');
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MeetingResult | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const sessionIdRef = useRef<string>('');
  const mimeTypeRef = useRef<string>('audio/webm');
  const isProcessingRef = useRef(false);

  const cleanup = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
  }, []);

  const processRecording = useCallback(async (chunks: Blob[], mimeType: string, sessionId: string) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    try {
      // 合并 chunks
      const audioBlob = new Blob(chunks, { type: mimeType });
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioData = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          ''
        )
      );

      // 保存录音
      setStatus('saving');
      logger.debug('Saving recording', { size: audioBlob.size, mimeType });

      const saveResult = await meetingInvoke('meeting:save-recording', {
        audioData,
        mimeType,
        sessionId,
      });

      if (!saveResult?.success) {
        throw new Error(saveResult?.error || '保存录音失败');
      }

      const filePath = saveResult.filePath;

      // 转写
      setStatus('transcribing');
      logger.debug('Transcribing', { filePath });

      const transcribeResult = await meetingInvoke('meeting:transcribe', { filePath });

      if (!transcribeResult?.success) {
        throw new Error(transcribeResult?.error || '转写失败');
      }

      const transcript = transcribeResult.text;
      const recordingDuration = transcribeResult.duration || 0;

      // 生成会议纪要
      setStatus('generating');
      logger.debug('Generating minutes');

      const minutesResult = await meetingInvoke('meeting:generate-minutes', { transcript });

      if (!minutesResult?.success) {
        throw new Error(minutesResult?.error || '生成会议纪要失败');
      }

      setResult({
        filePath,
        transcript,
        minutes: minutesResult.minutes,
        duration: recordingDuration,
        model: minutesResult.model || 'unknown',
      });
      setStatus('done');
      logger.info('Meeting processing complete');

    } catch (err) {
      logger.error('Processing error:', err);
      setError(err instanceof Error ? err.message : '处理失败');
      setStatus('error');
    } finally {
      isProcessingRef.current = false;
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (status === 'recording' || isProcessingRef.current) return;

    try {
      setError(null);
      setResult(null);

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
      startTimeRef.current = Date.now();
      setStatus('recording');
      setDuration(0);

      durationIntervalRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setDuration(elapsed);
      }, 1000);

    } catch (err) {
      cleanup();
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setError('请允许麦克风权限');
      } else {
        setError('无法访问麦克风');
      }
      setStatus('error');
    }
  }, [status, cleanup, processRecording]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const reset = useCallback(() => {
    cleanup();
    setStatus('idle');
    setDuration(0);
    setError(null);
    setResult(null);
    chunksRef.current = [];
    isProcessingRef.current = false;
  }, [cleanup]);

  return {
    status,
    duration,
    error,
    result,
    startRecording,
    stopRecording,
    reset,
  };
}

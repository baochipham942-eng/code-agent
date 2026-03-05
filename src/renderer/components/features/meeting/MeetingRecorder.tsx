// ============================================================================
// MeetingRecorder - 全屏会议录音 + 实时转录
// 对标 Otter.ai: 录音时实时显示文字，录完后精确转写+生成纪要
// ============================================================================

import React, { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import {
  Mic, Square, Pause, Play, Copy, Download, RotateCcw,
  FileText, AlignLeft, Check, ChevronDown, ChevronUp, Clock, Cpu,
  Search, ListChecks,
} from 'lucide-react';
import { useMeetingRecorder, type MeetingStatus, type LiveSegment } from '../../../hooks/useMeetingRecorder';
import { AudioWaveform } from './AudioWaveform';

// ── Helpers ──

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

interface ActionItem {
  text: string;
  checked: boolean;
  person?: string;
  deadline?: string;
}

function extractActionItems(markdown: string): ActionItem[] {
  const items: ActionItem[] = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const match = line.match(/^-\s*\[([\sx])\]\s*(.+)/);
    if (match) {
      const checked = match[1] === 'x';
      let text = match[2];
      let person: string | undefined;
      let deadline: string | undefined;

      // Parse "content — person | deadline" format
      const parts = text.split('—');
      if (parts.length > 1) {
        text = parts[0].trim();
        const meta = parts[1].split('|');
        person = meta[0]?.trim();
        deadline = meta[1]?.trim();
      }

      items.push({ text, checked, person, deadline });
    }
  }
  return items;
}

function extractChapters(markdown: string): { title: string; index: number }[] {
  const chapters: { title: string; index: number }[] = [];
  const lines = markdown.split('\n');
  lines.forEach((line, index) => {
    const match = line.match(/^####\s+(.+)/);
    if (match) {
      chapters.push({ title: match[1], index });
    }
  });
  return chapters;
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-700 rounded px-0.5">{part}</mark>
      : part
  );
}

const processingSteps: { key: MeetingStatus; label: string; estimate: string }[] = [
  { key: 'saving', label: '保存录音', estimate: '~2s' },
  { key: 'transcribing', label: '语音转写 (whisper)', estimate: '~10-30s' },
  { key: 'generating', label: '生成纪要 (LLM)', estimate: '~5-15s' },
];

// ── Live Transcript View (during recording) ──

const LiveTranscriptView: React.FC<{
  segments: LiveSegment[];
  interimText: string;
  duration: number;
}> = ({ segments, interimText, duration }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [segments, interimText]);

  const hasContent = segments.length > 0 || interimText;

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
      {!hasContent && (
        <div className="flex flex-col items-center justify-center h-full text-zinc-600">
          <Mic className="w-8 h-8 mb-3 opacity-30" />
          <p className="text-sm">正在聆听...</p>
          <p className="text-xs mt-1">语音内容将实时显示在这里</p>
        </div>
      )}

      {segments.map((seg, i) => (
        <div key={i} className="flex gap-3 mb-3 group">
          <span className="text-[11px] text-zinc-600 font-mono tabular-nums pt-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            {formatTimestamp(seg.timestamp)}
          </span>
          <p className="text-[14px] text-zinc-300 leading-relaxed">{seg.text}</p>
        </div>
      ))}

      {/* Interim (not yet finalized) text */}
      {interimText && (
        <div className="flex gap-3 mb-3">
          <span className="text-[11px] text-zinc-700 font-mono tabular-nums pt-0.5 flex-shrink-0">
            {formatTimestamp(duration)}
          </span>
          <p className="text-[14px] text-zinc-500 leading-relaxed italic">{interimText}</p>
        </div>
      )}
    </div>
  );
};

// ── Recording Control Bar (bottom of screen during recording) ──

const RecordingControlBar: React.FC<{
  status: MeetingStatus;
  duration: number;
  audioLevel: number;
  pauseCount: number;
  asrEngine: string;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}> = ({ status, duration, audioLevel, pauseCount, asrEngine, onPause, onResume, onStop }) => {
  const isPaused = status === 'paused';

  return (
    <div className="border-t border-zinc-800/60 bg-zinc-900/80 backdrop-blur-sm px-6 py-4 flex-shrink-0">
      <div className="flex items-center justify-between max-w-3xl mx-auto">
        {/* Left: Timer + Status */}
        <div className="flex items-center gap-4 min-w-[200px]">
          {/* Status dot */}
          {!isPaused ? (
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
          ) : (
            <span className="w-2.5 h-2.5 rounded-full bg-orange-400" />
          )}

          {/* Duration */}
          <span className={`text-2xl font-light font-mono tabular-nums ${isPaused ? 'text-zinc-500' : 'text-zinc-100'}`}>
            {formatDuration(duration)}
          </span>

          {/* Status label */}
          <span className={`text-[11px] font-medium uppercase tracking-wider ${
            isPaused ? 'text-orange-400/70' : 'text-red-400/70'
          }`}>
            {isPaused ? '已暂停' : '录音中'}
          </span>

          {pauseCount > 0 && (
            <span className="text-[10px] text-zinc-600 tabular-nums">({pauseCount}x暂停)</span>
          )}
        </div>

        {/* Center: Waveform + Controls */}
        <div className="flex items-center gap-6">
          <AudioWaveform audioLevel={audioLevel} isActive={!isPaused} color={isPaused ? 'blue' : 'red'} />

          {/* Pause/Resume */}
          <button
            onClick={isPaused ? onResume : onPause}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
              isPaused
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700/50'
            }`}
            title={isPaused ? '继续' : '暂停'}
          >
            {isPaused ? <Play className="w-4 h-4 ml-0.5" /> : <Pause className="w-4 h-4" />}
          </button>

          {/* Stop */}
          <button
            onClick={onStop}
            className="w-12 h-12 rounded-full bg-red-600 hover:bg-red-500 active:scale-95 transition-all flex items-center justify-center text-white shadow-lg shadow-red-900/30"
            title="停止录音"
          >
            <Square className="w-5 h-5" fill="white" />
          </button>
        </div>

        {/* Right: ASR Engine info */}
        <div className="flex items-center gap-2 min-w-[200px] justify-end">
          <Cpu className="w-3 h-3 text-zinc-600" />
          <span className="text-[10px] text-zinc-600 truncate max-w-[180px]">{asrEngine}</span>
        </div>
      </div>
    </div>
  );
};

// ── Processing View ──

const ProcessingView: React.FC<{
  status: MeetingStatus;
  duration: number;
  liveSegments: LiveSegment[];
}> = ({ status, duration, liveSegments }) => {
  const [stepElapsed, setStepElapsed] = useState(0);
  const stepStartRef = useRef(Date.now());

  useEffect(() => {
    stepStartRef.current = Date.now();
    setStepElapsed(0);
    const interval = setInterval(() => {
      setStepElapsed(Math.floor((Date.now() - stepStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [status]);

  return (
    <div className="flex flex-col items-center flex-1 overflow-hidden">
      {/* Progress area */}
      <div className="flex flex-col items-center py-8 px-6 flex-shrink-0">
        <span className="text-[11px] text-zinc-600 uppercase tracking-wider mb-1">处理中</span>
        <span className="text-2xl font-light font-mono text-zinc-500 tabular-nums mb-8">{formatDuration(duration)}</span>

        {/* Step progress */}
        <div className="w-full max-w-[320px] space-y-3">
          {processingSteps.map((step, i) => {
            const currentIdx = processingSteps.findIndex(s => s.key === status);
            const isCurrent = status === step.key;
            const isPast = currentIdx > i;

            return (
              <div key={step.key} className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0 transition-all duration-300 ${
                  isPast ? 'bg-blue-500 text-white'
                    : isCurrent ? 'bg-blue-500/15 text-blue-400 ring-2 ring-blue-500/40'
                    : 'bg-zinc-800/80 text-zinc-600'
                }`}>
                  {isPast ? <Check className="w-3 h-3" /> : i + 1}
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className={`text-[12px] ${isCurrent ? 'text-zinc-200' : isPast ? 'text-zinc-400' : 'text-zinc-600'}`}>
                      {step.label}
                    </span>
                    <span className="text-[10px] text-zinc-600 tabular-nums">
                      {isCurrent ? `${stepElapsed}s` : isPast ? '✓' : step.estimate}
                    </span>
                  </div>
                  {(isCurrent || isPast) && (
                    <div className="mt-1 h-[2px] rounded-full bg-zinc-800 overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-500 ${
                        isPast ? 'w-full bg-blue-500' : 'bg-blue-400 animate-pulse w-3/5'
                      }`} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Show live transcript collected during recording as preview */}
      {liveSegments.length > 0 && (
        <div className="flex-1 overflow-y-auto px-6 pb-4 w-full max-w-2xl mx-auto border-t border-zinc-800/40">
          <p className="text-[11px] text-zinc-600 uppercase tracking-wider my-3">录音时实时转录（预览）</p>
          {liveSegments.map((seg, i) => (
            <div key={i} className="flex gap-3 mb-2">
              <span className="text-[10px] text-zinc-700 font-mono tabular-nums pt-0.5 flex-shrink-0">
                {formatTimestamp(seg.timestamp)}
              </span>
              <p className="text-[13px] text-zinc-500 leading-relaxed">{seg.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Result View (Done state — 飞书妙记风格) ──

const ResultView: React.FC<{
  minutes: string;
  transcript: string;
  duration: number;
  pauseCount: number;
  model: string;
  onReset: () => void;
}> = ({ minutes, transcript, duration, pauseCount, model, onReset }) => {
  const [activeTab, setActiveTab] = useState<'minutes' | 'transcript' | 'actions'>('minutes');
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(false);

  const chapters = useMemo(() => extractChapters(minutes || ''), [minutes]);
  const actionItems = useMemo(() => extractActionItems(minutes || ''), [minutes]);

  // Render minutes with chapter anchors
  const minutesWithAnchors = useMemo(() => {
    if (!minutes) return null;
    let chapterIdx = 0;
    return minutes.split('\n').map((line, i) => {
      if (line.match(/^####\s+/)) {
        const anchor = `chapter-${chapterIdx++}`;
        return (
          <div key={i} id={anchor} className="font-bold text-[15px] text-zinc-100 mt-5 mb-2">
            {line.replace(/^####\s+/, '')}
          </div>
        );
      }
      if (!line.trim()) return <div key={i} className="h-2" />;
      return <div key={i}>{line}</div>;
    });
  }, [minutes]);

  const content = activeTab === 'minutes' ? minutes : transcript;

  const handleCopy = useCallback(async () => {
    const text = activeTab === 'actions'
      ? actionItems.map(a => `${a.checked ? '[x]' : '[ ]'} ${a.text}${a.person ? ` — ${a.person}` : ''}${a.deadline ? ` | ${a.deadline}` : ''}`).join('\n')
      : content;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content, activeTab, actionItems]);

  const handleSave = useCallback(() => {
    const text = activeTab === 'actions'
      ? actionItems.map(a => `${a.checked ? '[x]' : '[ ]'} ${a.text}${a.person ? ` — ${a.person}` : ''}${a.deadline ? ` | ${a.deadline}` : ''}`).join('\n')
      : content;
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meeting-${activeTab}-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [content, activeTab, actionItems]);

  const tabConfig = [
    { key: 'minutes' as const, icon: FileText, label: '纪要' },
    { key: 'transcript' as const, icon: AlignLeft, label: '转写原文' },
    { key: 'actions' as const, icon: ListChecks, label: `行动项${actionItems.length > 0 ? ` (${actionItems.length})` : ''}` },
  ];

  return (
    <div className="flex flex-col flex-1 overflow-hidden max-w-3xl mx-auto w-full">
      {/* Header */}
      <div className="px-6 pt-5 pb-0 space-y-3 flex-shrink-0">
        {/* Meta info */}
        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            完成
          </span>
          <span className="text-zinc-700">·</span>
          <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{formatDuration(Math.round(duration))}</span>
          {pauseCount > 0 && (<><span className="text-zinc-700">·</span><span>暂停 {pauseCount}次</span></>)}
          <span className="text-zinc-700">·</span>
          <span className="inline-flex items-center gap-1"><Cpu className="w-3 h-3" />{model}</span>
        </div>

        {/* Three-tab bar */}
        <div className="flex border-b border-zinc-800/60">
          {tabConfig.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-4 py-2 text-[12px] font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />{label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* ── Minutes Tab ── */}
        {activeTab === 'minutes' && (
          <div>
            {/* Chapter navigation */}
            {chapters.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2 pb-3 border-b border-zinc-800/40">
                {chapters.map((ch, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      const el = document.getElementById(`chapter-${i}`);
                      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    className="rounded-full bg-blue-500/10 px-3 py-1 text-[11px] font-medium text-blue-400 hover:bg-blue-500/20 transition-colors"
                  >
                    {ch.title}
                  </button>
                ))}
              </div>
            )}
            {/* Minutes content with anchors */}
            <div className="text-[14px] text-zinc-300 font-sans leading-[1.8]">
              {minutesWithAnchors}
            </div>
          </div>
        )}

        {/* ── Transcript Tab ── */}
        {activeTab === 'transcript' && (
          <div>
            {/* Search bar */}
            <div className="mb-4 relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索转写内容..."
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800/80 px-4 py-2 pl-10 text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none transition-colors"
              />
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-600" />
            </div>
            {/* Transcript with highlights */}
            <div className="text-[14px] text-zinc-300 font-sans leading-[1.8] whitespace-pre-wrap">
              {highlightText(transcript, searchQuery)}
            </div>
          </div>
        )}

        {/* ── Action Items Tab ── */}
        {activeTab === 'actions' && (
          <div className="space-y-3">
            {actionItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-zinc-600">
                <ListChecks className="w-8 h-8 mb-3 opacity-30" />
                <p className="text-sm">暂无行动项</p>
                <p className="text-xs mt-1">纪要中的 [ ] 项目会显示在这里</p>
              </div>
            ) : (
              actionItems.map((item, i) => (
                <div key={i} className="flex items-start gap-3 rounded-lg border border-zinc-800/60 bg-zinc-800/30 p-3 hover:bg-zinc-800/50 transition-colors">
                  <input
                    type="checkbox"
                    defaultChecked={item.checked}
                    className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-800 accent-blue-500"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-zinc-200 leading-relaxed">{item.text}</p>
                    {(item.person || item.deadline) && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {item.person && (
                          <span className="inline-flex items-center rounded bg-purple-500/10 px-2 py-0.5 text-[11px] text-purple-300 border border-purple-500/20">
                            {item.person}
                          </span>
                        )}
                        {item.deadline && (
                          <span className="inline-flex items-center rounded bg-orange-500/10 px-2 py-0.5 text-[11px] text-orange-300 border border-orange-500/20">
                            <Clock className="w-3 h-3 mr-1" />{item.deadline}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="flex gap-2 px-6 py-3 border-t border-zinc-800/50 flex-shrink-0">
        <button
          onClick={handleCopy}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[12px] font-medium bg-zinc-800 text-zinc-300 rounded-lg hover:bg-zinc-700 border border-zinc-700/40 transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? '已复制' : '复制'}
        </button>
        <button
          onClick={handleSave}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[12px] font-medium bg-zinc-800 text-zinc-300 rounded-lg hover:bg-zinc-700 border border-zinc-700/40 transition-colors"
        >
          <Download className="w-3.5 h-3.5" />保存为文件
        </button>
        <button
          onClick={onReset}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[12px] font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />新的录音
        </button>
      </div>
    </div>
  );
};

// ── Main Component ──

export const MeetingRecorder: React.FC = () => {
  const {
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
  } = useMeetingRecorder();

  const isProcessing = status === 'saving' || status === 'transcribing' || status === 'generating';
  const isRecording = status === 'recording' || status === 'paused';

  return (
    <div className="flex flex-col h-full">
      {/* ── Idle: Ready screen (same layout as recording, but not started) ── */}
      {status === 'idle' && (
        <>
          {/* Empty transcript area with placeholder */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="flex flex-col items-center justify-center h-full text-zinc-600">
              <Mic className="w-8 h-8 mb-3 opacity-30" />
              <p className="text-sm">点击下方按钮开始录音</p>
              <p className="text-xs mt-1">语音内容将实时显示在这里</p>
            </div>
          </div>

          {/* Bottom control bar with start button */}
          <div className="border-t border-zinc-800/60 bg-zinc-900/80 backdrop-blur-sm px-6 py-4 flex-shrink-0">
            <div className="flex items-center justify-center gap-4 max-w-3xl mx-auto">
              <button
                onClick={startRecording}
                className="flex items-center gap-2 px-8 py-3 rounded-full bg-emerald-600 hover:bg-emerald-500 active:scale-95 transition-all text-white shadow-lg shadow-emerald-900/30 text-[14px] font-medium"
              >
                <Mic className="w-5 h-5" />
                开始录音
              </button>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-800/50 border border-zinc-800">
                <Cpu className="w-3 h-3 text-zinc-600" />
                <span className="text-[10px] text-zinc-600">{asrEngine}</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Recording / Paused: Live transcript + control bar ── */}
      {isRecording && (
        <>
          <LiveTranscriptView segments={liveSegments} interimText={interimText} duration={duration} />
          <RecordingControlBar
            status={status}
            duration={duration}
            audioLevel={audioLevel}
            pauseCount={pauseCount}
            asrEngine={asrEngine}
            onPause={pauseRecording}
            onResume={resumeRecording}
            onStop={stopRecording}
          />
        </>
      )}

      {/* ── Processing ── */}
      {isProcessing && (
        <ProcessingView status={status} duration={duration} liveSegments={liveSegments} />
      )}

      {/* ── Transcribed: user chooses next step ── */}
      {status === 'transcribed' && result && (
        <div className="flex flex-col items-center justify-center flex-1 px-6 space-y-5">
          <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <Check className="w-6 h-6 text-emerald-400" />
          </div>
          <div className="text-center">
            <p className="text-[15px] text-zinc-200 font-medium mb-1">转写完成</p>
            <p className="text-[12px] text-zinc-500">
              时长 {formatDuration(Math.round(result.duration))} · {result.transcript.length} 字
            </p>
          </div>

          {/* Preview snippet */}
          <div className="w-full max-w-md rounded-lg bg-zinc-800/50 border border-zinc-700/40 p-4 max-h-32 overflow-y-auto">
            <p className="text-[12px] text-zinc-400 leading-relaxed">
              {result.transcript.slice(0, 300)}{result.transcript.length > 300 ? '...' : ''}
            </p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={skipMinutes}
              className="px-6 py-2.5 text-[13px] bg-zinc-800 text-zinc-300 rounded-lg hover:bg-zinc-700 border border-zinc-700/50 transition-colors"
            >
              仅保留转写
            </button>
            <button
              onClick={generateMinutes}
              className="px-6 py-2.5 text-[13px] bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors flex items-center gap-1.5"
            >
              <FileText className="w-3.5 h-3.5" />
              生成会议纪要
            </button>
          </div>
        </div>
      )}

      {/* ── Done ── */}
      {status === 'done' && result && (
        <ResultView
          minutes={result.minutes}
          transcript={result.transcript}
          duration={result.duration}
          pauseCount={pauseCount}
          model={result.model}
          onReset={reset}
        />
      )}

      {/* ── Error ── */}
      {status === 'error' && (
        <div className="flex flex-col items-center justify-center flex-1 px-6 space-y-4">
          <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
            <Mic className="w-6 h-6 text-red-400" />
          </div>
          <div className="text-center">
            <p className="text-[14px] text-red-400 mb-1">{error}</p>
            <p className="text-[12px] text-zinc-600">请检查麦克风权限后重试</p>
          </div>
          <button
            onClick={reset}
            className="px-6 py-2.5 text-[13px] bg-zinc-800 text-zinc-300 rounded-lg hover:bg-zinc-700 border border-zinc-700/50 transition-colors"
          >
            重试
          </button>
        </div>
      )}
    </div>
  );
};

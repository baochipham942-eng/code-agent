// ============================================================================
// ThoughtDisplay - AI Thinking Process Display Component
// ============================================================================
// Displays AI's thinking/reasoning process with:
// - Gradient background effect
// - Running timer
// - ESC cancel functionality
// - Loading animation
// ============================================================================

import React, { useEffect, useState, useCallback } from 'react';
import { Brain, Loader2 } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

export interface ThoughtDisplayProps {
  /** The thinking/reasoning content to display */
  thought: string;
  /** Whether the AI is currently thinking */
  isThinking: boolean;
  /** Timestamp when thinking started (for timer) */
  startTime?: number;
  /** Callback when user cancels (ESC key) */
  onCancel?: () => void;
  /** Optional CSS class name */
  className?: string;
}

// ============================================================================
// Timer Hook
// ============================================================================

const useTimer = (startTime?: number, isActive: boolean = true) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime || !isActive) {
      setElapsed(0);
      return;
    }

    // Calculate initial elapsed time
    setElapsed(Math.floor((Date.now() - startTime) / 1000));

    // Update every second
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime, isActive]);

  return elapsed;
};

// ============================================================================
// Format Time Helper
// ============================================================================

const formatTime = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
};

// ============================================================================
// Main Component
// ============================================================================

export const ThoughtDisplay: React.FC<ThoughtDisplayProps> = ({
  thought,
  isThinking,
  startTime,
  onCancel,
  className = '',
}) => {
  const elapsed = useTimer(startTime, isThinking);

  // ESC key handler
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onCancel && isThinking) {
        event.preventDefault();
        onCancel();
      }
    },
    [onCancel, isThinking]
  );

  // Register ESC key listener
  useEffect(() => {
    if (isThinking && onCancel) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isThinking, onCancel, handleKeyDown]);

  // Don't render if not thinking and no thought content
  if (!isThinking && !thought) {
    return null;
  }

  return (
    <div
      className={`
        relative overflow-hidden rounded-xl
        bg-gradient-to-br from-zinc-800/90 via-zinc-800/70 to-zinc-900/90
        border border-zinc-700/50
        shadow-lg shadow-black/20
        animate-fade-in
        ${className}
      `}
    >
      {/* Gradient overlay effect */}
      <div className="absolute inset-0 bg-gradient-to-r from-primary-500/5 via-transparent to-accent-purple/5 pointer-events-none" />

      {/* Animated gradient border effect when thinking */}
      {isThinking && (
        <div className="absolute inset-0 rounded-xl overflow-hidden pointer-events-none">
          <div
            className="absolute inset-[-2px] rounded-xl opacity-30"
            style={{
              background: 'linear-gradient(90deg, #6366f1, #a855f7, #ec4899, #6366f1)',
              backgroundSize: '300% 100%',
              animation: 'gradient-shift 3s ease-in-out infinite',
            }}
          />
        </div>
      )}

      {/* Content container */}
      <div className="relative p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {/* Brain icon with animation */}
            <div className="relative">
              <Brain className={`w-4 h-4 text-primary-400 ${isThinking ? 'animate-pulse' : ''}`} />
              {isThinking && (
                <div className="absolute inset-0 animate-ping">
                  <Brain className="w-4 h-4 text-primary-400 opacity-40" />
                </div>
              )}
            </div>
            <span className="text-sm font-medium text-primary-400">
              {isThinking ? 'Thinking...' : 'Thought'}
            </span>

            {/* Loading spinner */}
            {isThinking && (
              <Loader2 className="w-3.5 h-3.5 text-zinc-500 animate-spin ml-1" />
            )}
          </div>

          {/* Timer */}
          {isThinking && startTime && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 font-mono">
                {formatTime(elapsed)}
              </span>
            </div>
          )}
        </div>

        {/* Thought content */}
        <div
          className={`
            text-sm text-zinc-300 leading-relaxed
            ${isThinking ? 'animate-fade-in' : ''}
          `}
        >
          {thought || (
            <span className="text-zinc-500 italic">Processing...</span>
          )}

          {/* Typing cursor when thinking */}
          {isThinking && (
            <span className="inline-block w-0.5 h-4 ml-0.5 bg-primary-400 animate-blink align-middle" />
          )}
        </div>

        {/* ESC hint */}
        {isThinking && onCancel && (
          <div className="mt-3 pt-3 border-t border-zinc-700/50">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <kbd className="px-1.5 py-0.5 rounded bg-zinc-700/50 border border-zinc-600/50 font-mono text-zinc-400">
                ESC
              </kbd>
              <span>to cancel</span>
            </div>
          </div>
        )}
      </div>

      {/* Animation keyframes */}
      <style>{`
        @keyframes gradient-shift {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }

        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }

        .animate-blink {
          animation: blink 1s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
};

// ============================================================================
// Compact Variant
// ============================================================================

export interface CompactThoughtDisplayProps {
  /** Brief thought summary */
  thought: string;
  /** Whether currently thinking */
  isThinking: boolean;
  /** Optional CSS class name */
  className?: string;
}

export const CompactThoughtDisplay: React.FC<CompactThoughtDisplayProps> = ({
  thought,
  isThinking,
  className = '',
}) => {
  if (!isThinking && !thought) {
    return null;
  }

  return (
    <div
      className={`
        inline-flex items-center gap-2 px-3 py-1.5
        rounded-full
        bg-gradient-to-r from-zinc-800/80 to-zinc-800/60
        border border-zinc-700/40
        ${className}
      `}
    >
      <Brain className={`w-3.5 h-3.5 text-primary-400 ${isThinking ? 'animate-pulse' : ''}`} />
      <span className="text-xs text-zinc-400 max-w-[200px] truncate">
        {thought || 'Thinking...'}
      </span>
      {isThinking && (
        <Loader2 className="w-3 h-3 text-zinc-500 animate-spin" />
      )}
    </div>
  );
};

export default ThoughtDisplay;

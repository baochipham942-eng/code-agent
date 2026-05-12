import { useEffect, useRef, useState } from 'react';
import { recordStreamingPerformanceCounter } from '../utils/streamingPerformanceMetrics';

export const STREAMING_MARKDOWN_RENDER_THROTTLE_MS = 96;

const MARKDOWN_STREAMING_TRIGGER = /(```|`|\*\*|__|~~|\[[^\]]*\]\(|!\[[^\]]*\]\(|^#{1,6}\s|^\s*[-*+]\s+|^\s*\d+\.\s+|^\s*>|^\s*\|.*\||<\/?[a-z][\s\S]*?>|[A-Z][A-Z0-9]+-\d+|(?:^|\s)(?:\.{0,2}\/|~\/|\/)[^\s`"'<>]+|!\w+)/m;

export function shouldRenderStreamingContentAsMarkdown(content: string): boolean {
  return MARKDOWN_STREAMING_TRIGGER.test(content);
}

export function useThrottledStreamingContent(
  content: string,
  enabled: boolean,
  intervalMs = STREAMING_MARKDOWN_RENDER_THROTTLE_MS,
): string {
  const [renderContent, setRenderContent] = useState(content);
  const latestContentRef = useRef(content);
  const lastFlushAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestContentRef.current = content;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    if (!enabled) {
      clearTimer();
      lastFlushAtRef.current = Date.now();
      setRenderContent((previous) => previous === content ? previous : content);
      return;
    }

    const flush = () => {
      timerRef.current = null;
      lastFlushAtRef.current = Date.now();
      recordStreamingPerformanceCounter('stream.markdown.throttle_flush');
      setRenderContent(latestContentRef.current);
    };

    const elapsed = Date.now() - lastFlushAtRef.current;
    if (elapsed >= intervalMs) {
      clearTimer();
      flush();
      return;
    }

    if (!timerRef.current) {
      timerRef.current = setTimeout(flush, intervalMs - elapsed);
    }
  }, [content, enabled, intervalMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return enabled ? renderContent : content;
}

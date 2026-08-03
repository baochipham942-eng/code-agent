// 工单 2026-08-01（流式渲染自然化）真机观感验收 harness：
// 走与 TraceNodeRenderer 完全相同的渲染路径（useSmoothStreamingText → MessageContent
// 纯文本流式 + streamingTailStart 尾段淡入 span），由 shot 脚本通过
// window.__STREAM_RENDER_DEMO__ 模拟 GLM-5 式大块吐字并截图。
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageContent } from '../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import { useSmoothStreamingText } from '../../src/renderer/hooks/useSmoothStreamingText';
import '../../src/renderer/styles/global.css';

interface StreamRenderDemoDriver {
  push: (chunk: string) => void;
  finish: () => void;
  snapshot: () => {
    contentLength: number;
    displayLength: number;
    isAnimating: boolean;
    tailStartIndex: number | null;
    tailSegmentInDom: boolean;
  };
}

declare global {
  interface Window {
    __STREAM_RENDER_DEMO__?: StreamRenderDemoDriver;
  }
}

function StreamRenderDemo(): React.ReactElement {
  const [content, setContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(true);
  const { displayContent, isAnimating, tailStartIndex } = useSmoothStreamingText({ content, isStreaming });

  useEffect(() => {
    window.__STREAM_RENDER_DEMO__ = {
      push: (chunk) => setContent((prev) => prev + chunk),
      finish: () => setIsStreaming(false),
      snapshot: () => ({
        contentLength: content.length,
        displayLength: displayContent.length,
        isAnimating,
        tailStartIndex,
        tailSegmentInDom: document.querySelector('.streaming-tail-segment') !== null,
      }),
    };
    document.body.setAttribute('data-stream-demo-ready', 'true');
  });

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-6 text-zinc-100">
      <section className="mx-auto flex max-w-3xl flex-col gap-4">
        <p className="text-xs text-zinc-500">stream-render naturalize harness（hook → MessageContent 真实路径）</p>
        <div className="text-zinc-200 leading-relaxed select-text">
          <MessageContent
            content={displayContent}
            isUser={false}
            isStreaming={isStreaming || isAnimating}
            messageId="stream-render-demo"
            streamingTailStart={tailStartIndex}
          />
        </div>
      </section>
    </main>
  );
}

function main(): void {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Missing #root for stream render naturalize harness.');
  }
  createRoot(rootElement).render(<StreamRenderDemo />);
}

main();

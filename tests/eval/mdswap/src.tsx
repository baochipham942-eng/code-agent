import React, { useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Components } from 'react-markdown';
import { Streamdown, defaultUrlTransform } from 'streamdown';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { cjk } from '@streamdown/cjk';
import {
  CodeBlock,
  InlineCode,
  MarkdownRenderer,
} from '../../../src/renderer/components/features/chat/MessageBubble/messageContentParts';
import { fixtures } from './fixtures';
import 'streamdown/styles.css';
import '../../../src/renderer/styles/global.css';

type Side = 'neo' | 'streamdown';
type Phase = 'active' | 'complete' | 'static';
type RenderRequest = { side: Side; content: string; phase: Phase; nonce: number };

const neoComponents: Components = {
  code({ node, className, children }) {
    const value = String(children).replace(/\n$/, '');
    const block = node?.position?.start.line !== node?.position?.end.line || className?.startsWith('language-');
    if (block) return <CodeBlock language={className?.replace('language-', '') ?? ''} code={value} />;
    return <InlineCode>{children}</InlineCode>;
  },
  pre({ children }) { return <>{children}</>; },
};

function RenderSurface({ request, onCommit }: { request: RenderRequest; onCommit: () => void }) {
  useLayoutEffect(onCommit, [request, onCommit]);
  if (request.side === 'neo') {
    return <MarkdownRenderer key={request.phase === 'static' ? request.nonce : 'neo-live'} content={request.content} components={neoComponents} isStreaming={request.phase === 'active'} />;
  }
  return (
    <Streamdown
      key={request.phase === 'static' ? request.nonce : 'streamdown-live'}
      mode={request.phase === 'static' ? 'static' : 'streaming'}
      isAnimating={request.phase === 'active'}
      plugins={{ code, math, mermaid, cjk }}
      linkSafety={{ enabled: false }}
      urlTransform={(url, key, node) => url.startsWith('neo://') ? url : defaultUrlTransform(url, key, node)}
    >
      {request.content}
    </Streamdown>
  );
}

function Harness() {
  const [request, setRequest] = useState<RenderRequest>({ side: 'neo', content: '', phase: 'active', nonce: 0 });
  const callbacks = useMemo(() => new Map<number, () => void>(), []);
  const render = (next: Omit<RenderRequest, 'nonce'>) => new Promise<void>((resolve) => {
    setRequest((current) => {
      const nonce = current.nonce + 1;
      callbacks.set(nonce, resolve);
      return { ...next, nonce };
    });
  });
  const onCommit = () => {
    const callback = callbacks.get(request.nonce);
    if (callback) {
      callbacks.delete(request.nonce);
      requestAnimationFrame(() => requestAnimationFrame(callback));
    }
  };
  (window as typeof window & { mdswap?: unknown }).mdswap = { render, fixtures };
  return <main id="surface"><RenderSurface request={request} onCommit={onCommit} /></main>;
}

createRoot(document.getElementById('root')!).render(<Harness />);

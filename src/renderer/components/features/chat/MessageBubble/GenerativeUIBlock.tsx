// ============================================================================
// GenerativeUIBlock - Sandboxed iframe renderer for AI-generated HTML widgets
// ============================================================================

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Sparkles, Code2, Copy, Check, ExternalLink } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { UI } from '@shared/constants';

const INJECTED_STYLES = `<style>
body {
  margin: 0; padding: 16px;
  background: #18181b; color: #e4e4e7;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
}
* { box-sizing: border-box; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(113, 113, 122, 0.4); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(113, 113, 122, 0.6); }
</style>`;

const HEIGHT_REPORTER_SCRIPT = `<script>
(function() {
  function reportHeight() {
    var h = document.body.scrollHeight;
    window.parent.postMessage({ type: 'generative-ui-resize', height: h }, '*');
  }
  // Report on load, resize, mutation
  window.addEventListener('load', reportHeight);
  window.addEventListener('resize', reportHeight);
  var observer = new MutationObserver(reportHeight);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  // Initial reports with delay for rendering
  setTimeout(reportHeight, 50);
  setTimeout(reportHeight, 200);
  setTimeout(reportHeight, 500);
})();
</script>`;

function buildSrcdoc(code: string): string {
  // If the code already has <html> or <head>, inject styles into head
  if (/<html/i.test(code)) {
    const withStyles = code.replace(/<head([^>]*)>/i, `<head$1>${INJECTED_STYLES}`);
    return withStyles.replace(/<\/body>/i, `${HEIGHT_REPORTER_SCRIPT}</body>`);
  }
  // Otherwise wrap it
  return `<!DOCTYPE html><html><head>${INJECTED_STYLES}</head><body>${code}${HEIGHT_REPORTER_SCRIPT}</body></html>`;
}

// Simple source code viewer (avoids circular dependency with CodeBlock in MessageContent)
const SourceView = memo(function SourceView({ code }: { code: string }) {
  const lines = code.split('\n');
  const showLineNumbers = lines.length > 3;

  return (
    <div className="relative">
      <SyntaxHighlighter
        style={oneDark}
        language="html"
        showLineNumbers={showLineNumbers}
        customStyle={{
          margin: 0,
          padding: '1rem',
          background: 'transparent',
          fontSize: '0.75rem',
          lineHeight: '1.25rem',
        }}
        lineNumberStyle={{
          minWidth: '2.5em',
          paddingRight: '1em',
          color: 'rgb(113 113 122)',
          userSelect: 'none',
        }}
        wrapLongLines={false}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
});

export const GenerativeUIBlock = memo(function GenerativeUIBlock({ code }: { code: string }) {
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(100);
  const [loaded, setLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const srcdoc = buildSrcdoc(code);

  // Listen for height messages from iframe
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    function handleMessage(event: MessageEvent) {
      if (event.data?.type === 'generative-ui-resize' && typeof event.data.height === 'number') {
        const h = Math.max(100, Math.min(600, event.data.height));
        setIframeHeight(h);
        setLoaded(true);
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
  }, [code]);

  const handleOpen = useCallback(() => {
    const blob = new Blob([srcdoc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Clean up after a delay
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [srcdoc]);

  // Fallback: empty code
  if (!code.trim()) {
    return null;
  }

  return (
    <div className="my-3 rounded-xl bg-zinc-900 border border-zinc-700 shadow-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800 border-b border-zinc-700">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-violet-400" />
          <span className="text-xs font-medium text-violet-400">Generative UI</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSource(s => !s)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 transition-all text-xs ${
              showSource ? 'text-violet-400 bg-zinc-700' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>Source</span>
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-400" />
                <span className="text-green-400">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
          <button
            onClick={handleOpen}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>Open</span>
          </button>
        </div>
      </div>

      {/* Content: Source or Preview */}
      {showSource ? (
        <SourceView code={code} />
      ) : (
        <div className="relative">
          {!loaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900 text-zinc-500 text-xs">
              Loading...
            </div>
          )}
          <iframe
            ref={iframeRef}
            sandbox="allow-scripts"
            srcDoc={srcdoc}
            style={{ height: `${iframeHeight}px`, minHeight: '100px', maxHeight: '600px' }}
            className="w-full border-0 bg-zinc-900"
            title="Generative UI"
            onLoad={() => setLoaded(true)}
          />
        </div>
      )}
    </div>
  );
});

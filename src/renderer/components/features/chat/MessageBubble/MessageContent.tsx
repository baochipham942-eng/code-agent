// ============================================================================
// MessageContent - Markdown rendering using react-markdown
// ============================================================================

import React, { useState, useMemo, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Code2, Copy, Check } from 'lucide-react';
import type { MessageContentProps } from './types';
import { UI } from '@shared/constants';
import 'katex/dist/katex.min.css';
import type { Components } from 'react-markdown';
import type { Element } from 'hast';

// Language display names and colors
const languageConfig: Record<string, { color: string; name: string }> = {
  typescript: { color: 'text-blue-400', name: 'TypeScript' },
  ts: { color: 'text-blue-400', name: 'TypeScript' },
  tsx: { color: 'text-blue-400', name: 'TSX' },
  javascript: { color: 'text-yellow-400', name: 'JavaScript' },
  js: { color: 'text-yellow-400', name: 'JavaScript' },
  jsx: { color: 'text-yellow-400', name: 'JSX' },
  python: { color: 'text-green-400', name: 'Python' },
  py: { color: 'text-green-400', name: 'Python' },
  rust: { color: 'text-orange-400', name: 'Rust' },
  rs: { color: 'text-orange-400', name: 'Rust' },
  go: { color: 'text-cyan-400', name: 'Go' },
  bash: { color: 'text-emerald-400', name: 'Bash' },
  shell: { color: 'text-emerald-400', name: 'Shell' },
  sh: { color: 'text-emerald-400', name: 'Shell' },
  zsh: { color: 'text-emerald-400', name: 'Zsh' },
  json: { color: 'text-amber-400', name: 'JSON' },
  html: { color: 'text-orange-400', name: 'HTML' },
  css: { color: 'text-blue-400', name: 'CSS' },
  scss: { color: 'text-pink-400', name: 'SCSS' },
  sql: { color: 'text-purple-400', name: 'SQL' },
  yaml: { color: 'text-red-400', name: 'YAML' },
  yml: { color: 'text-red-400', name: 'YAML' },
  markdown: { color: 'text-zinc-400', name: 'Markdown' },
  md: { color: 'text-zinc-400', name: 'Markdown' },
  java: { color: 'text-red-400', name: 'Java' },
  c: { color: 'text-blue-300', name: 'C' },
  cpp: { color: 'text-blue-300', name: 'C++' },
  csharp: { color: 'text-purple-400', name: 'C#' },
  cs: { color: 'text-purple-400', name: 'C#' },
  php: { color: 'text-indigo-400', name: 'PHP' },
  ruby: { color: 'text-red-400', name: 'Ruby' },
  rb: { color: 'text-red-400', name: 'Ruby' },
  swift: { color: 'text-orange-400', name: 'Swift' },
  kotlin: { color: 'text-purple-400', name: 'Kotlin' },
  kt: { color: 'text-purple-400', name: 'Kotlin' },
  dart: { color: 'text-cyan-400', name: 'Dart' },
  diff: { color: 'text-zinc-400', name: 'Diff' },
  xml: { color: 'text-orange-400', name: 'XML' },
  toml: { color: 'text-zinc-400', name: 'TOML' },
  ini: { color: 'text-zinc-400', name: 'INI' },
  dockerfile: { color: 'text-cyan-400', name: 'Dockerfile' },
  docker: { color: 'text-cyan-400', name: 'Docker' },
  graphql: { color: 'text-pink-400', name: 'GraphQL' },
  gql: { color: 'text-pink-400', name: 'GraphQL' },
};

// Code block with copy button and syntax highlighting
const CodeBlock = memo(function CodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
  }, [code]);

  const config = languageConfig[language] || { color: 'text-zinc-400', name: language || 'code' };
  const lines = code.split('\n');
  const showLineNumbers = lines.length > 3;

  return (
    <div className="my-3 rounded-xl bg-surface-950 overflow-hidden border border-zinc-800/50 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800/30 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <Code2 className={`w-3.5 h-3.5 ${config.color}`} />
          <span className={`text-xs font-medium ${config.color}`}>
            {config.name}
          </span>
          <span className="text-xs text-zinc-600">
            {lines.length} line{lines.length > 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700/50 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
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
      </div>
      {/* Code with syntax highlighting */}
      <div className="relative">
        <SyntaxHighlighter
          style={oneDark}
          language={language || 'text'}
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
    </div>
  );
});

// Inline code component
const InlineCode = memo(function InlineCode({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <code className="px-1.5 py-0.5 mx-0.5 rounded-md bg-zinc-900/80 text-primary-300 text-xs font-mono border border-zinc-700/50">
      {children}
    </code>
  );
});

// Main message content component
export const MessageContent: React.FC<MessageContentProps> = memo(function MessageContent({ content, isUser }) {
  // For user messages, render as plain text (no markdown processing)
  if (isUser) {
    return (
      <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
        {content}
      </div>
    );
  }

  // Custom components for react-markdown
  const components: Components = useMemo(
    () => ({
      // Code blocks and inline code
      code({ node, className, children, ...props }) {
        // Check if this is a code block (has a parent pre element)
        // react-markdown wraps code blocks in <pre><code>
        const isCodeBlock = node?.position?.start.line !== node?.position?.end.line ||
          (className && className.startsWith('language-'));

        // Get the actual code content
        const codeContent = String(children).replace(/\n$/, '');

        if (isCodeBlock && className) {
          const language = className.replace('language-', '');
          return <CodeBlock language={language} code={codeContent} />;
        }

        // For inline code that doesn't have a language class
        if (!className && codeContent.includes('\n')) {
          return <CodeBlock language="" code={codeContent} />;
        }

        return <InlineCode>{children}</InlineCode>;
      },

      // Override pre to just render children (CodeBlock handles the wrapper)
      pre({ children }) {
        return <>{children}</>;
      },

      // Tables
      table({ children }) {
        return (
          <div className="my-3 overflow-x-auto">
            <table className="min-w-full text-xs border-collapse">
              {children}
            </table>
          </div>
        );
      },
      thead({ children }) {
        return <thead className="bg-zinc-800/50">{children}</thead>;
      },
      th({ children, style }) {
        return (
          <th
            className="px-3 py-2 text-left font-semibold text-zinc-200 border border-zinc-700/50"
            style={style}
          >
            {children}
          </th>
        );
      },
      tbody({ children }) {
        return <tbody>{children}</tbody>;
      },
      tr({ children }) {
        return <tr className="even:bg-zinc-800/20 odd:bg-zinc-900/30">{children}</tr>;
      },
      td({ children, style }) {
        return (
          <td
            className="px-3 py-2 text-zinc-300 border border-zinc-700/50"
            style={style}
          >
            {children}
          </td>
        );
      },

      // Headings
      h1({ children }) {
        return <h1 className="text-xl font-bold text-zinc-100 mt-4 mb-2">{children}</h1>;
      },
      h2({ children }) {
        return <h2 className="text-lg font-bold text-zinc-100 mt-3 mb-2">{children}</h2>;
      },
      h3({ children }) {
        return <h3 className="text-base font-semibold text-zinc-200 mt-3 mb-1">{children}</h3>;
      },
      h4({ children }) {
        return <h4 className="text-sm font-semibold text-zinc-200 mt-2 mb-1">{children}</h4>;
      },
      h5({ children }) {
        return <h5 className="text-sm font-medium text-zinc-300 mt-2 mb-1">{children}</h5>;
      },
      h6({ children }) {
        return <h6 className="text-xs font-medium text-zinc-400 mt-2 mb-1">{children}</h6>;
      },

      // Paragraphs
      p({ children }) {
        return <p className="my-1">{children}</p>;
      },

      // Lists
      ul({ children }) {
        return <ul className="my-2 pl-5 space-y-1 list-disc">{children}</ul>;
      },
      ol({ children }) {
        return <ol className="my-2 pl-5 space-y-1 list-decimal">{children}</ol>;
      },
      li({ children }) {
        return <li className="text-zinc-300">{children}</li>;
      },

      // Blockquote
      blockquote({ children }) {
        return (
          <blockquote className="my-2 pl-4 border-l-2 border-primary-500/50 text-zinc-400 italic">
            {children}
          </blockquote>
        );
      },

      // Horizontal rule
      hr() {
        return <hr className="my-4 border-zinc-700/50" />;
      },

      // Links
      a({ href, children }) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-400 hover:text-primary-300 underline underline-offset-2"
          >
            {children}
          </a>
        );
      },

      // Text formatting
      strong({ children }) {
        return <strong className="font-semibold text-zinc-100">{children}</strong>;
      },
      em({ children }) {
        return <em className="italic text-zinc-200">{children}</em>;
      },
      del({ children }) {
        return <del className="line-through text-zinc-500">{children}</del>;
      },

      // Images
      img({ src, alt }) {
        return (
          <img
            src={src}
            alt={alt || ''}
            className="max-w-full h-auto rounded-lg my-2"
            loading="lazy"
          />
        );
      },
    }),
    []
  );

  return (
    <div className="text-sm leading-relaxed break-words prose prose-invert prose-sm max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

// Re-export for backward compatibility
export { CodeBlock, InlineCode as InlineTextWithCode };

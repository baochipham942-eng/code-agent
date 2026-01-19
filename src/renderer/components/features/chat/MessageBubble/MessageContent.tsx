// ============================================================================
// MessageContent - Markdown rendering for message content
// ============================================================================

import React, { useState } from 'react';
import { Code2, Copy, Check } from 'lucide-react';
import type { MessageContentProps, CodeBlockProps, MarkdownBlockData } from './types';
import { parseMarkdownBlocks, languageConfig } from './utils';
import { UI } from '@shared/constants';

// Main message content component
export const MessageContent: React.FC<MessageContentProps> = ({ content, isUser }) => {
  // Split by code blocks
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
      {parts.map((part, index) => {
        if (part.startsWith('```')) {
          return <CodeBlock key={index} content={part} />;
        }
        // Render inline code and tables for non-user messages
        if (!isUser) {
          return <RichTextContent key={index} text={part} />;
        }
        return <span key={index}>{part}</span>;
      })}
    </div>
  );
};

// Code block component with enhanced styling
export const CodeBlock: React.FC<CodeBlockProps> = ({ content }) => {
  const [copied, setCopied] = useState(false);

  // Extract language and code
  const match = content.match(/```(\w*)\n?([\s\S]*?)```/);
  const language = match?.[1]?.toLowerCase() || '';
  const code = match?.[2]?.trim() || content.replace(/```/g, '').trim();
  const config = languageConfig[language] || { color: 'text-zinc-400' };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
  };

  // Count lines for line numbers
  const lines = code.split('\n');
  const showLineNumbers = lines.length > 3;

  return (
    <div className="my-3 rounded-xl bg-surface-950 overflow-hidden border border-zinc-800/50 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800/30 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <Code2 className={`w-3.5 h-3.5 ${config.color}`} />
          <span className={`text-xs font-medium ${config.color}`}>
            {language || 'code'}
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
      {/* Code with optional line numbers */}
      <div className="relative">
        <pre className={`p-4 overflow-x-auto ${showLineNumbers ? 'pl-12' : ''}`}>
          {showLineNumbers && (
            <div className="absolute left-0 top-0 bottom-0 w-10 flex flex-col items-end pr-3 pt-4 text-xs text-zinc-600 select-none bg-zinc-900/30 border-r border-zinc-800/30">
              {lines.map((_, i) => (
                <span key={i} className="leading-5">{i + 1}</span>
              ))}
            </div>
          )}
          <code className="text-xs text-zinc-300 font-mono leading-5">{code}</code>
        </pre>
      </div>
    </div>
  );
};

// Rich text content with tables, headers, lists and inline formatting
const RichTextContent: React.FC<{ text: string }> = ({ text }) => {
  const blocks = parseMarkdownBlocks(text);

  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} block={block} />
      ))}
    </>
  );
};

// Render a single markdown block
const MarkdownBlock: React.FC<{ block: MarkdownBlockData }> = ({ block }) => {
  switch (block.type) {
    case 'hr':
      return <hr className="my-4 border-zinc-700/50" />;

    case 'heading': {
      const HeadingTag = `h${block.level}` as keyof JSX.IntrinsicElements;
      const sizeClasses: Record<number, string> = {
        1: 'text-xl font-bold text-zinc-100 mt-4 mb-2',
        2: 'text-lg font-bold text-zinc-100 mt-3 mb-2',
        3: 'text-base font-semibold text-zinc-200 mt-3 mb-1',
        4: 'text-sm font-semibold text-zinc-200 mt-2 mb-1',
        5: 'text-sm font-medium text-zinc-300 mt-2 mb-1',
        6: 'text-xs font-medium text-zinc-400 mt-2 mb-1',
      };
      return (
        <HeadingTag className={sizeClasses[block.level || 1]}>
          <InlineTextWithCode text={block.content} />
        </HeadingTag>
      );
    }

    case 'blockquote':
      return (
        <blockquote className="my-2 pl-4 border-l-2 border-primary-500/50 text-zinc-400 italic">
          <InlineTextWithCode text={block.content} />
        </blockquote>
      );

    case 'table':
      return <MarkdownTable tableText={block.content} />;

    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag className={`my-2 pl-5 space-y-1 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
          {block.items?.map((item, i) => (
            <li key={i} className="text-zinc-300">
              <InlineTextWithCode text={item} />
            </li>
          ))}
        </ListTag>
      );
    }

    case 'paragraph':
    default:
      return <InlineTextWithCode text={block.content} />;
  }
};

// Parse and render markdown tables
const MarkdownTable: React.FC<{ tableText: string }> = ({ tableText }) => {
  const lines = tableText.trim().split('\n').filter(line => line.trim());
  if (lines.length < 2) return <span>{tableText}</span>;

  // Parse header
  const headerLine = lines[0];
  const headers = headerLine.split('|').map(h => h.trim()).filter(Boolean);

  // Check for separator line (---|---|---)
  const separatorLine = lines[1];
  if (!separatorLine.match(/^[\s|:-]+$/)) {
    return <span>{tableText}</span>;
  }

  // Parse alignment from separator
  const alignments = separatorLine.split('|').map(s => s.trim()).filter(Boolean).map(sep => {
    if (sep.startsWith(':') && sep.endsWith(':')) return 'center';
    if (sep.endsWith(':')) return 'right';
    return 'left';
  });

  // Parse data rows
  const dataRows = lines.slice(2).map(line =>
    line.split('|').map(cell => cell.trim()).filter((_, i, arr) => i > 0 || arr[0] !== '')
  );

  return (
    <div className="my-3 overflow-x-auto">
      <table className="min-w-full text-xs border-collapse">
        <thead>
          <tr className="bg-zinc-800/50">
            {headers.map((header, i) => (
              <th
                key={i}
                className="px-3 py-2 text-left font-semibold text-zinc-200 border border-zinc-700/50"
                style={{ textAlign: alignments[i] || 'left' }}
              >
                <InlineTextWithCode text={header} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              className={rowIndex % 2 === 0 ? 'bg-zinc-900/30' : 'bg-zinc-800/20'}
            >
              {headers.map((_, cellIndex) => (
                <td
                  key={cellIndex}
                  className="px-3 py-2 text-zinc-300 border border-zinc-700/50"
                  style={{ textAlign: alignments[cellIndex] || 'left' }}
                >
                  <InlineTextWithCode text={row[cellIndex] || ''} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// Handle inline formatting: code, bold, italic, strikethrough
export const InlineTextWithCode: React.FC<{ text: string }> = ({ text }) => {
  // Combined regex for inline formatting
  const inlineRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~)/g;
  const parts = text.split(inlineRegex);

  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;

        // Inline code
        if (part.startsWith('`') && part.endsWith('`')) {
          const code = part.slice(1, -1);
          return (
            <code
              key={index}
              className="px-1.5 py-0.5 mx-0.5 rounded-md bg-zinc-900/80 text-primary-300 text-xs font-mono border border-zinc-700/50"
            >
              {code}
            </code>
          );
        }

        // Bold **text**
        if (part.startsWith('**') && part.endsWith('**')) {
          const content = part.slice(2, -2);
          return <strong key={index} className="font-semibold text-zinc-100">{content}</strong>;
        }

        // Italic *text*
        if (part.startsWith('*') && part.endsWith('*')) {
          const content = part.slice(1, -1);
          return <em key={index} className="italic text-zinc-200">{content}</em>;
        }

        // Strikethrough ~~text~~
        if (part.startsWith('~~') && part.endsWith('~~')) {
          const content = part.slice(2, -2);
          return <del key={index} className="line-through text-zinc-500">{content}</del>;
        }

        return <span key={index}>{part}</span>;
      })}
    </>
  );
};

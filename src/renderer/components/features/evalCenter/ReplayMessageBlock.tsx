// ============================================================================
// ReplayMessageBlock - 单个结构化 block 渲染
// ============================================================================

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  buildBrowserComputerActionPreview,
  formatBrowserComputerActionArguments,
  formatBrowserComputerActionResultDetails,
  summarizeBrowserComputerActionResult,
} from '../../../utils/browserComputerActionPreview';

export interface ToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  resultMetadata?: Record<string, unknown>;
  success: boolean;
  duration: number;
  category: string;
}

export interface ReplayBlockData {
  type: 'user' | 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error';
  content: string;
  toolCall?: ToolCallData;
  timestamp: number;
}

interface Props {
  block: ReplayBlockData;
}

const CATEGORY_COLORS: Record<string, string> = {
  Read: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  Edit: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
  Write: 'text-green-400 bg-green-500/10 border-green-500/20',
  Bash: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
  Search: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
  Web: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  Agent: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
  Skill: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20',
  Other: 'text-zinc-400 bg-zinc-600/10 border-zinc-600/20',
};

export const ReplayMessageBlock: React.FC<Props> = ({ block }) => {
  switch (block.type) {
    case 'user':
      return <UserBlock content={block.content} />;
    case 'thinking':
      return <ThinkingBlock content={block.content} />;
    case 'text':
      return <TextBlock content={block.content} />;
    case 'tool_call':
      return <ToolCallBlock toolCall={block.toolCall!} />;
    case 'error':
      return <ErrorBlock content={block.content} />;
    default:
      return null;
  }
};

const UserBlock: React.FC<{ content: string }> = ({ content }) => (
  <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3">
    <div className="text-[10px] text-blue-400/60 font-medium mb-1 uppercase tracking-wider">User</div>
    <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto leading-relaxed">
      {content}
    </div>
  </div>
);

const ThinkingBlock: React.FC<{ content: string }> = ({ content }) => {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 150 ? content.slice(0, 150) + '...' : content;

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-zinc-800 transition"
      >
        <span className="font-mono text-[10px] text-zinc-500">{expanded ? '▼' : '▶'}</span>
        <span className="text-[11px] text-zinc-500">thinking</span>
        {!expanded && (
          <span className="text-[11px] text-zinc-600 truncate ml-1">{preview}</span>
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2.5 border-t border-zinc-700/20">
          <div className="text-[11px] text-zinc-500 whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto leading-relaxed mt-1.5 font-mono">
            {content}
          </div>
        </div>
      )}
    </div>
  );
};

const TextBlock: React.FC<{ content: string }> = ({ content }) => (
  <div className="px-1">
    <div className="text-sm text-zinc-400 whitespace-pre-wrap break-words leading-relaxed">
      {content}
    </div>
  </div>
);

const ToolCallBlock: React.FC<{ toolCall: ToolCallData }> = ({ toolCall }) => {
  const [expanded, setExpanded] = useState(false);
  const colorClass = CATEGORY_COLORS[toolCall.category] || CATEGORY_COLORS.Other;
  const statusIcon = toolCall.success ? '✓' : '✗';
  const statusColor = toolCall.success ? 'text-green-400' : 'text-red-400';

  // Format args preview
  const argsPreview = formatArgsPreview(toolCall.name, toolCall.args);
  const resultDetails = formatResultDetails(toolCall);

  return (
    <div className={`border rounded-lg overflow-hidden ${colorClass.split(' ').slice(1).join(' ')}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5 transition"
      >
        <span className={`text-xs ${statusColor}`}>{statusIcon}</span>
        <span className={`text-[11px] font-mono font-medium ${colorClass.split(' ')[0]}`}>
          {toolCall.name}
        </span>
        <span className="text-[10px] text-zinc-600 truncate flex-1">{argsPreview}</span>
        <span className="text-[10px] text-zinc-600 shrink-0">{toolCall.duration}ms</span>
        <ChevronDown
          className={`w-3 h-3 text-zinc-600 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
        />
      </button>
      {resultDetails && (
        <div className="px-3 pb-2 text-[10px] text-zinc-500 whitespace-pre-wrap break-words">
          {resultDetails}
        </div>
      )}
      {expanded && (
        <div className="px-3 pb-2.5 border-t border-zinc-700/20 pt-2 space-y-2">
          {/* Args */}
          <div>
            <div className="text-[10px] text-zinc-600 mb-0.5">ARGS</div>
            <pre className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto bg-zinc-900/30 rounded p-2 font-mono">
              {formatArgsDetails(toolCall.name, toolCall.args)}
            </pre>
          </div>
          {/* Result */}
          {resultDetails && (
            <div>
              <div className="text-[10px] text-zinc-600 mb-0.5">RESULT</div>
              <pre className="text-[11px] text-zinc-500 whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto bg-zinc-900/30 rounded p-2 font-mono">
                {resultDetails}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ErrorBlock: React.FC<{ content: string }> = ({ content }) => (
  <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
    <div className="text-[10px] text-red-400/60 font-medium mb-0.5">ERROR</div>
    <div className="text-[11px] text-red-300 whitespace-pre-wrap break-words max-h-[100px] overflow-y-auto">
      {content}
    </div>
  </div>
);

function formatArgsPreview(toolName: string, args: Record<string, unknown>): string {
  const browserComputerPreview = buildBrowserComputerActionPreview({
    name: toolName,
    arguments: args,
  });
  if (browserComputerPreview) {
    return browserComputerPreview.target
      ? `${browserComputerPreview.summary} -> ${browserComputerPreview.target}`
      : browserComputerPreview.summary;
  }

  const lower = toolName.toLowerCase();
  if ((lower === 'read') && args.file_path) {
    return String(args.file_path);
  }
  if ((lower === 'edit') && args.file_path) {
    return String(args.file_path);
  }
  if ((lower === 'write') && args.file_path) {
    return String(args.file_path);
  }
  if ((lower === 'bash') && args.command) {
    const cmd = String(args.command);
    return cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd;
  }
  if ((lower === 'glob') && args.pattern) {
    return String(args.pattern);
  }
  if ((lower === 'grep') && args.pattern) {
    return String(args.pattern);
  }
  // Generic: show first string value
  const vals = Object.values(args);
  if (vals.length > 0) {
    const first = String(vals[0]);
    return first.length > 50 ? first.slice(0, 50) + '...' : first;
  }
  return '';
}

export function formatArgsDetails(toolName: string, args: Record<string, unknown>): string {
  return formatBrowserComputerActionArguments(toolName, args) || JSON.stringify(args, null, 2);
}

export function formatResultDetails(toolCall: ToolCallData): string | null {
  const result = toolCall.result
    ? {
        toolCallId: toolCall.id,
        success: toolCall.success,
        output: toolCall.success ? toolCall.result : undefined,
        error: toolCall.success ? undefined : toolCall.result,
        metadata: toolCall.resultMetadata,
      }
    : toolCall.resultMetadata
      ? {
          toolCallId: toolCall.id,
          success: toolCall.success,
          metadata: toolCall.resultMetadata,
        }
      : undefined;

  const browserComputerResult = formatBrowserComputerActionResultDetails({
    name: toolCall.name,
    arguments: toolCall.args,
    result,
  }) || summarizeBrowserComputerActionResult({
    name: toolCall.name,
    arguments: toolCall.args,
    result,
  });

  if (browserComputerResult) {
    return browserComputerResult;
  }
  return toolCall.result || null;
}

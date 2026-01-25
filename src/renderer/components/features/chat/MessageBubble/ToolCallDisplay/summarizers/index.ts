// ============================================================================
// Tool Summarizers - Smart result summaries for different tool types
// ============================================================================

import type { ToolCall } from '@shared/types';
import { summarizeBash } from './bashSummarizer';
import { summarizeGrep } from './grepSummarizer';
import { summarizeGlob } from './globSummarizer';
import { summarizeRead } from './readSummarizer';
import { summarizeEdit, summarizeWrite } from './editSummarizer';
import { summarizeDefault } from './defaultSummarizer';

/**
 * Generate a smart summary for a tool call result
 * Returns null if no summary is available
 */
export function summarizeTool(toolCall: ToolCall): string | null {
  if (!toolCall.result) return null;

  const { name, result } = toolCall;

  // Error case: show first line of error message
  if (!result.success && result.error) {
    const firstLine = result.error.split('\n')[0];
    return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
  }

  // Select summarizer based on tool type
  switch (name) {
    case 'bash':
      return summarizeBash(toolCall);

    case 'grep':
      return summarizeGrep(toolCall);

    case 'glob':
      return summarizeGlob(toolCall);

    case 'read_file':
    case 'read_pdf':
      return summarizeRead(toolCall);

    case 'edit_file':
      return summarizeEdit(toolCall);

    case 'write_file':
      return summarizeWrite(toolCall);

    case 'list_directory':
      return summarizeListDirectory(toolCall);

    case 'task':
      return summarizeTask(toolCall);

    case 'todo_write':
      return summarizeTodoWrite(toolCall);

    case 'mcp':
      return summarizeMcp(toolCall);

    case 'ppt_generate':
      return summarizePptGenerate(toolCall);

    case 'image_generate':
      return summarizeImageGenerate(toolCall);

    case 'video_generate':
      return summarizeVideoGenerate(toolCall);

    case 'web_fetch':
      return summarizeWebFetch(toolCall);

    case 'ask_user_question':
      return summarizeAskUser(toolCall);

    default:
      return summarizeDefault(toolCall);
  }
}

// ============================================================================
// Additional Summarizers
// ============================================================================

function summarizeListDirectory(toolCall: ToolCall): string | null {
  const output = toolCall.result?.output;
  if (!output) return 'Empty';

  if (Array.isArray(output)) {
    return `${output.length} items`;
  }

  const lines = String(output).trim().split('\n').filter(Boolean);
  return `${lines.length} items`;
}

function summarizeTask(toolCall: ToolCall): string | null {
  if (toolCall.result?.success) {
    return 'Completed';
  }
  return null;
}

function summarizeTodoWrite(toolCall: ToolCall): string | null {
  const todos = toolCall.arguments?.todos as Array<{ status: string }> | undefined;
  if (todos && Array.isArray(todos)) {
    const completed = todos.filter((t) => t.status === 'completed').length;
    return `${completed}/${todos.length} done`;
  }
  return 'Updated';
}

function summarizeMcp(toolCall: ToolCall): string | null {
  if (toolCall.result?.success) {
    const output = toolCall.result.output;
    if (typeof output === 'string' && output.length < 60) {
      return output;
    }
    return 'Done';
  }
  return null;
}

function summarizePptGenerate(toolCall: ToolCall): string | null {
  const metadata = toolCall.result?.metadata;
  if (metadata) {
    const slidesCount = metadata.slidesCount as number | undefined;
    if (slidesCount) {
      return `${slidesCount} slides`;
    }
  }
  return 'Generated';
}

function summarizeImageGenerate(toolCall: ToolCall): string | null {
  const metadata = toolCall.result?.metadata;
  if (metadata) {
    const imagePath = metadata.imagePath as string | undefined;
    if (imagePath) {
      const fileName = imagePath.split('/').pop() || 'image';
      return fileName;
    }
    if (metadata.imageBase64) {
      return 'Base64 image';
    }
  }
  return 'Generated';
}

function summarizeVideoGenerate(toolCall: ToolCall): string | null {
  const metadata = toolCall.result?.metadata;
  if (metadata) {
    const duration = metadata.duration as number | undefined;
    const aspectRatio = metadata.aspectRatio as string | undefined;
    const videoPath = metadata.videoPath as string | undefined;

    if (videoPath) {
      const fileName = videoPath.split('/').pop() || 'video.mp4';
      return fileName;
    }

    const parts: string[] = [];
    if (duration) parts.push(`${duration}s`);
    if (aspectRatio) parts.push(aspectRatio);

    if (parts.length > 0) {
      return `视频生成完成 (${parts.join(', ')})`;
    }
  }
  return '视频生成完成';
}

function summarizeWebFetch(toolCall: ToolCall): string | null {
  const output = toolCall.result?.output;
  if (!output) return null;

  const str = String(output);
  const lines = str.split('\n').length;
  const chars = str.length;

  if (chars > 5000) {
    return `~${Math.round(chars / 1024)}KB`;
  }
  return `${lines} lines`;
}

function summarizeAskUser(toolCall: ToolCall): string | null {
  const output = toolCall.result?.output;
  if (output) {
    const answer = String(output);
    if (answer.length <= 40) {
      return answer;
    }
    return answer.slice(0, 37) + '...';
  }
  return 'Answered';
}

// Re-export individual summarizers
export { summarizeBash } from './bashSummarizer';
export { summarizeGrep } from './grepSummarizer';
export { summarizeGlob } from './globSummarizer';
export { summarizeRead } from './readSummarizer';
export { summarizeEdit, summarizeWrite } from './editSummarizer';
export { summarizeDefault } from './defaultSummarizer';

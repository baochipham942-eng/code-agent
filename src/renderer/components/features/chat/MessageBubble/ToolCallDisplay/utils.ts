// ============================================================================
// ToolCallDisplay Utils - Icon mapping, parameter formatting, duration formatting
// ============================================================================

import React from 'react';
import {
  Terminal,
  FileText,
  FilePlus,
  FileEdit,
  Search,
  FolderOpen,
  Globe,
  Bot,
  ListTodo,
  MessageCircleQuestion,
  Sparkles,
  Plug,
  Database,
  FileCode,
  Camera,
  Monitor,
  Users,
  MessageSquare,
  GitBranch,
  Target,
  Wrench,
  ScanEye,
  ClipboardList,
  Clipboard,
  Image,
  Presentation,
} from 'lucide-react';
import type { ToolCall } from '@shared/types';

// ============================================================================
// Tool Icon Mapping
// ============================================================================

export function getToolIcon(name: string): React.ReactNode {
  const iconMap: Record<string, React.ReactNode> = {
    // Gen 1 - Basic file operations
    bash: React.createElement(Terminal, { size: 14 }),
    read_file: React.createElement(FileText, { size: 14 }),
    write_file: React.createElement(FilePlus, { size: 14 }),
    edit_file: React.createElement(FileEdit, { size: 14 }),

    // Gen 2 - Search and navigation
    glob: React.createElement(Search, { size: 14 }),
    grep: React.createElement(Search, { size: 14 }),
    list_directory: React.createElement(FolderOpen, { size: 14 }),
    web_search: React.createElement(Globe, { size: 14 }),

    // Gen 3 - Subagent and planning
    task: React.createElement(Bot, { size: 14 }),
    todo_write: React.createElement(ListTodo, { size: 14 }),
    ask_user_question: React.createElement(MessageCircleQuestion, { size: 14 }),

    // Gen 4 - Skill system and network
    skill: React.createElement(Sparkles, { size: 14 }),
    web_fetch: React.createElement(Globe, { size: 14 }),
    mcp: React.createElement(Plug, { size: 14 }),
    read_pdf: React.createElement(FileText, { size: 14 }),

    // Gen 5 - RAG and memory
    memory_store: React.createElement(Database, { size: 14 }),
    memory_search: React.createElement(Search, { size: 14 }),
    code_index: React.createElement(FileCode, { size: 14 }),
    ppt_generate: React.createElement(Presentation, { size: 14 }),
    image_generate: React.createElement(Image, { size: 14 }),

    // Gen 6 - Computer Use
    screenshot: React.createElement(Camera, { size: 14 }),
    computer_use: React.createElement(Monitor, { size: 14 }),
    browser_action: React.createElement(Globe, { size: 14 }),

    // Gen 7 - Multi-agent
    spawn_agent: React.createElement(Users, { size: 14 }),
    agent_message: React.createElement(MessageSquare, { size: 14 }),
    workflow_orchestrate: React.createElement(GitBranch, { size: 14 }),

    // Gen 8 - Self-evolution
    strategy_optimize: React.createElement(Target, { size: 14 }),
    tool_create: React.createElement(Wrench, { size: 14 }),
    self_evaluate: React.createElement(ScanEye, { size: 14 }),

    // Planning tools
    plan_update: React.createElement(ClipboardList, { size: 14 }),
    plan_read: React.createElement(Clipboard, { size: 14 }),
    findings_write: React.createElement(FileText, { size: 14 }),
  };

  // MCP tools use Plug icon
  if (name.startsWith('mcp_') || name === 'mcp') {
    return React.createElement(Plug, { size: 14 });
  }

  return iconMap[name] || React.createElement(Wrench, { size: 14 });
}

// ============================================================================
// Parameter Formatting
// ============================================================================

export function formatParams(toolCall: ToolCall): string {
  const { name, arguments: args } = toolCall;
  if (!args) return '';

  switch (name) {
    case 'bash':
      return truncateCommand(String(args.command || ''));

    case 'read_file':
    case 'write_file':
    case 'edit_file': {
      let filePath = String(args.file_path || '');
      // Clean up potential parameter mixing
      if (filePath.includes(' offset=') || filePath.includes(' limit=')) {
        filePath = filePath.split(' ')[0];
      }
      return shortenPath(filePath);
    }

    case 'grep':
      return `"${String(args.pattern || '').slice(0, 20)}"`;

    case 'glob':
      return String(args.pattern || '').slice(0, 30);

    case 'list_directory':
      return shortenPath(String(args.path || '.'));

    case 'web_fetch':
      return shortenUrl(String(args.url || ''));

    case 'task':
      return String(args.description || '').slice(0, 30);

    case 'mcp':
      return `${args.server}/${args.tool}`;

    case 'skill':
      return String(args.skill || args.name || '');

    case 'read_pdf':
      return shortenPath(String(args.file_path || ''));

    case 'ppt_generate':
      return String(args.topic || '').slice(0, 30);

    case 'image_generate':
      return String(args.prompt || '').slice(0, 30);

    case 'todo_write': {
      const todos = args.todos as Array<{ status: string }> | undefined;
      if (todos && Array.isArray(todos)) {
        const completed = todos.filter((t) => t.status === 'completed').length;
        return `${completed}/${todos.length}`;
      }
      return '';
    }

    case 'ask_user_question':
      return String(args.question || '').slice(0, 30);

    default: {
      // Try to find first meaningful argument
      const firstArg = Object.values(args)[0];
      if (typeof firstArg === 'string') {
        return firstArg.slice(0, 30);
      }
      return '';
    }
  }
}

function truncateCommand(cmd: string): string {
  // Get first line, max 40 chars
  const firstLine = cmd.split('\n')[0];
  if (firstLine.length <= 40) return firstLine;
  return firstLine.slice(0, 37) + '...';
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  // Show last two path segments
  return '.../' + parts.slice(-2).join('/');
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathPart = parsed.pathname.length > 20 ? parsed.pathname.slice(0, 17) + '...' : parsed.pathname;
    return parsed.hostname + pathPart;
  } catch {
    return url.slice(0, 30);
  }
}

// ============================================================================
// Duration Formatting
// ============================================================================

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ============================================================================
// Tool Name Display
// ============================================================================

export function getToolDisplayName(name: string): string {
  // CamelCase for display
  const displayNames: Record<string, string> = {
    bash: 'Bash',
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    glob: 'Glob',
    grep: 'Grep',
    list_directory: 'ListDir',
    task: 'Task',
    todo_write: 'Todo',
    ask_user_question: 'Ask',
    skill: 'Skill',
    web_fetch: 'Fetch',
    web_search: 'Search',
    mcp: 'MCP',
    read_pdf: 'ReadPDF',
    ppt_generate: 'PPT',
    image_generate: 'Image',
    memory_store: 'Store',
    memory_search: 'Recall',
    code_index: 'Index',
    screenshot: 'Screenshot',
    computer_use: 'Computer',
    browser_action: 'Browser',
    spawn_agent: 'Spawn',
    agent_message: 'Message',
    workflow_orchestrate: 'Workflow',
    strategy_optimize: 'Optimize',
    tool_create: 'Create',
    self_evaluate: 'Evaluate',
    plan_update: 'Plan',
    plan_read: 'ReadPlan',
    findings_write: 'Finding',
  };

  if (name.startsWith('mcp_')) {
    // Parse MCP tool name: mcp_<serverName>_<toolName>
    const parts = name.match(/^mcp_([^_]+)_(.+)$/);
    if (parts) {
      return `MCP:${parts[2]}`;
    }
    return name;
  }

  return displayNames[name] || name;
}

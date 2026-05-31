// ============================================================================
// Context Buckets - 将 context 来源分类为 4 个首屏 bucket
// ============================================================================

import type { Message } from '@shared/contract';

export type ContextBucket = 'rules' | 'files' | 'web' | 'other';

export interface BucketSummary {
  rules: number;
  files: number;
  web: number;
  other: number;
}

// ── Attachment 分类映射 ──

const ATTACHMENT_BUCKET: Record<string, ContextBucket> = {
  code: 'rules',
  text: 'files',
  pdf: 'files',
  excel: 'files',
  data: 'files',
  document: 'files',
  html: 'web',
  image: 'other',
  folder: 'other',
  other: 'other',
};

// ── ToolCall 分类映射 ──

const TOOL_BUCKET_EXACT: Record<string, ContextBucket> = {
  Read: 'files',
  Write: 'files',
  Edit: 'files',
  MultiEdit: 'files',
  NotebookRead: 'files',
  NotebookEdit: 'files',
  WebSearch: 'web',
  WebFetch: 'web',
};

const TOOL_BUCKET_PREFIX: Array<[string, ContextBucket]> = [
  ['mcp__firecrawl__', 'web'],
  ['mcp__chrome-devtools__', 'web'],
  ['Skill', 'rules'],
];

/**
 * 对单个 attachment category 分类
 */
function classifyAttachment(category: string): ContextBucket {
  return ATTACHMENT_BUCKET[category] ?? 'other';
}

/**
 * 对单个 tool call name 分类
 */
function classifyToolCall(toolName: string): ContextBucket {
  if (TOOL_BUCKET_EXACT[toolName]) return TOOL_BUCKET_EXACT[toolName];
  for (const [prefix, bucket] of TOOL_BUCKET_PREFIX) {
    if (toolName.startsWith(prefix)) return bucket;
  }
  return 'other';
}

/**
 * 单个 context item（用于列表展示）
 */
export interface ContextItem {
  id: string;
  label: string;
  detail: string;
  bucket: ContextBucket;
  source: 'attachment' | 'tool';
  path?: string;
}

const FILE_TOOL_NAMES = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit']);

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeContextPath(path: string): string {
  return path.replace(/\/+$/, '').replace(/\/+/g, '/');
}

function basename(path: string): string {
  const normalized = normalizeContextPath(path);
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

function getToolFilePath(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (!FILE_TOOL_NAMES.has(toolName)) return null;
  const value = asString(args?.file_path)
    ?? asString(args?.path)
    ?? asString(args?.notebook_path);
  return value ? normalizeContextPath(value) : null;
}

function getWebLabel(toolName: string, args: Record<string, unknown> | undefined): string | null {
  if (toolName === 'WebSearch') {
    return asString(args?.query);
  }
  if (toolName === 'WebFetch') {
    return asString(args?.url);
  }
  if (toolName.startsWith('mcp__firecrawl__')) {
    return asString(args?.url) ?? asString(args?.query) ?? asString(args?.prompt);
  }
  if (toolName.startsWith('mcp__chrome-devtools__')) {
    return asString(args?.url) ?? asString(args?.query);
  }
  return null;
}

function truncateLabel(label: string, maxLength: number): string {
  return label.length > maxLength ? `${label.substring(0, maxLength)}…` : label;
}

/**
 * 从最近消息中提取 context items 列表
 */
export function extractContextItems(messages: Message[], recentCount = 30): ContextItem[] {
  const items: ContextItem[] = [];
  const seen = new Set<string>();
  const recent = messages.slice(-recentCount);

  for (const msg of recent) {
    if (msg.attachments) {
      for (const att of msg.attachments) {
        const attPath = asString((att as { path?: unknown }).path);
        const key = attPath ? `att:file:${normalizeContextPath(attPath)}` : `att:${att.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          id: key,
          label: att.name,
          detail: att.category || att.type,
          bucket: classifyAttachment(att.category || 'other'),
          source: 'attachment',
          path: attPath ? normalizeContextPath(attPath) : undefined,
        });
      }
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        const args = tc.arguments as Record<string, unknown>;
        const bucket = classifyToolCall(tc.name);
        let label: string;
        let detail = tc.name;
        let path: string | undefined;

        if (bucket === 'files') {
          const filePath = getToolFilePath(tc.name, args);
          if (!filePath) continue;
          path = filePath;
          label = basename(filePath);
        } else if (bucket === 'web') {
          const webLabel = getWebLabel(tc.name, args);
          if (!webLabel) continue;
          label = truncateLabel(webLabel, 40);
        } else if (bucket === 'rules' && tc.name === 'Skill') {
          const skill = asString(args?.command) ?? asString(args?.skill);
          if (!skill) continue;
          label = skill;
          detail = 'Skill';
        } else {
          continue;
        }

        const key = path ? `tool:file:${path}:${tc.name}` : `tool:${tc.name}:${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ id: key, label, detail, bucket, source: 'tool', path });
      }
    }
  }

  return items;
}

/**
 * 从最近消息中统计各 bucket 的 context item 数量
 */
export function computeBucketSummary(messages: Message[], recentCount = 30): BucketSummary {
  const summary: BucketSummary = { rules: 0, files: 0, web: 0, other: 0 };
  const seen = new Set<string>();
  const items = extractContextItems(messages, recentCount);

  for (const item of items) {
    const key = item.path ? `${item.bucket}:${item.path}` : `${item.bucket}:${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    summary[item.bucket]++;
  }

  return summary;
}

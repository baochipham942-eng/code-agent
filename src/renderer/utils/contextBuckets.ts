// ============================================================================
// Context Buckets - 将 context 来源分类为 4 个首屏 bucket
// ============================================================================

import type { Message } from '@shared/types';

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
  Glob: 'files',
  Grep: 'files',
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
export function classifyAttachment(category: string): ContextBucket {
  return ATTACHMENT_BUCKET[category] ?? 'other';
}

/**
 * 对单个 tool call name 分类
 */
export function classifyToolCall(toolName: string): ContextBucket {
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
        const key = `att:${att.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          id: key,
          label: att.name,
          detail: att.category || att.type,
          bucket: classifyAttachment(att.category || 'other'),
          source: 'attachment',
        });
      }
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        const args = tc.arguments as Record<string, unknown>;
        const bucket = classifyToolCall(tc.name);
        // 提取有意义的标签
        let label = tc.name;
        let detail = '';
        if (['Read', 'Write', 'Edit'].includes(tc.name)) {
          const fp = (args?.file_path || args?.path) as string | undefined;
          if (fp) {
            label = fp.split('/').pop() || fp;
            detail = tc.name;
          }
        } else if (tc.name === 'Bash') {
          const cmd = (args?.command) as string | undefined;
          if (cmd) {
            label = cmd.length > 40 ? cmd.substring(0, 40) + '…' : cmd;
            detail = 'Bash';
          }
        } else if (tc.name === 'Grep' || tc.name === 'Glob') {
          const pattern = (args?.pattern) as string | undefined;
          if (pattern) {
            label = pattern.length > 30 ? pattern.substring(0, 30) + '…' : pattern;
            detail = tc.name;
          }
        } else if (tc.name === 'WebSearch' || tc.name === 'WebFetch') {
          const query = (args?.query || args?.url) as string | undefined;
          if (query) {
            label = query.length > 40 ? query.substring(0, 40) + '…' : query;
            detail = tc.name;
          }
        } else if (tc.name === 'Skill') {
          const cmd = (args?.command || args?.skill) as string | undefined;
          if (cmd) { label = cmd; detail = 'Skill'; }
        }
        // 去重：同文件多次 Read 只显示一次
        const key = `tool:${tc.name}:${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ id: key, label, detail, bucket, source: 'tool' });
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
  const recent = messages.slice(-recentCount);

  for (const msg of recent) {
    if (msg.attachments) {
      for (const att of msg.attachments) {
        const bucket = classifyAttachment(att.category || 'other');
        summary[bucket]++;
      }
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        const bucket = classifyToolCall(tc.name);
        summary[bucket]++;
      }
    }
  }

  return summary;
}

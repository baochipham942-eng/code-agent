// ============================================================================
// Message Types
// ============================================================================

import type { ToolCall, ToolResult } from './tool';
import type { WorkbenchMessageMetadata } from './conversationEnvelope';
import type { ModelDecisionEventData } from './modelDecision';
import type { TurnQualitySummary } from './turnQuality';
import type { SessionAutomationMessageMetadata } from './sessionAutomation';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageVisibility = 'active' | 'rewound';

// 附件文件类别（用于精细化处理）
export type AttachmentCategory =
  | 'image'      // 图片：PNG, JPEG, GIF, WebP
  | 'audio'      // 音频：MP3, WAV, M4A, etc.
  | 'video'      // 视频：MP4, WebM, MOV, etc.
  | 'pdf'        // PDF 文档
  | 'excel'      // Excel 表格：XLSX, XLS（支持解析）
  | 'presentation' // 演示文稿：PPTX/PPT
  | 'archive'    // 压缩包：ZIP/TAR/GZ/RAR/7Z
  | 'code'       // 代码文件：JS, TS, Python, etc.
  | 'text'       // 纯文本：TXT, MD
  | 'data'       // 数据文件：JSON, CSV, XML
  | 'document'   // 办公文档：DOCX
  | 'html'       // 网页：HTML
  | 'folder'     // 文件夹
  | 'other';     // 其他

export type AttachmentMediaState =
  | 'pending'
  | 'downloading'
  | 'embedded'
  | 'transcribing'
  | 'ready'
  | 'failed';

export interface PresentationSlideSummary {
  index: number;
  title?: string;
  textPreview?: string;
  textRuns?: number;
  imageCount?: number;
  tableCount?: number;
}

export interface PresentationSummary {
  title?: string;
  format: 'pptx' | 'ppt';
  slideCount?: number;
  slides?: PresentationSlideSummary[];
  truncated?: boolean;
  parseError?: string;
}

export interface ArchiveEntrySummary {
  path: string;
  size?: number;
  compressedSize?: number;
  isDirectory?: boolean;
}

export interface ArchiveManifest {
  format: string;
  supported: boolean;
  totalFiles: number;
  totalDirectories?: number;
  totalUncompressedSize?: number;
  totalCompressedSize?: number;
  entries: ArchiveEntrySummary[];
  dangerousEntries?: string[];
  truncated?: boolean;
  note?: string;
}

// 附件类型
export interface MessageAttachment {
  id: string;
  type: 'image' | 'file';
  category: AttachmentCategory;  // 细粒度分类
  name: string;
  size: number;
  mimeType: string;
  // 图片: base64 数据 URL
  // 文件: 提取的文本内容
  data?: string;
  path?: string;
  // 图片预览 (缩略图)
  thumbnail?: string;
  // PDF 特有：页数
  pageCount?: number;
  // Excel 特有：sheet 数和行数
  sheetCount?: number;
  rowCount?: number;
  // Excel 特有：JSON 格式数据（供 SpreadsheetBlock 交互式渲染）
  sheetsJson?: string;
  // Word 特有：JSON 格式数据（供 DocumentBlock 交互式渲染）
  docxJson?: string;
  // PowerPoint 特有：JSON 格式摘要（供预览和模型上下文使用）
  pptJson?: string;
  // 压缩包特有：目录清单摘要，不自动解压
  archiveManifest?: ArchiveManifest;
  // 代码特有：语言
  language?: string;
  // 文件夹特有：文件列表和统计
  files?: Array<{ path: string; content: string; size: number }>;
  folderStats?: { totalFiles: number; totalSize: number; byType: Record<string, number> };
  // 媒体处理状态，用于展示下载、嵌入、转写、失败等生命周期
  mediaState?: AttachmentMediaState;
  // 来源和处理元数据，例如渠道消息 ID、转写结果、下载状态
  metadata?: Record<string, unknown>;
}

// 消息来源类型
export type MessageSource = 'user' | 'skill' | 'system' | 'goal' | 'model' | 'automation';

// Subagent 消息子类型
export type MessageSubtype = 'init' | 'result' | 'thinking' | 'tool_use';

// Compaction 摘要块（Claude Code 风格上下文压缩）
export type CompactionSource =
  | 'manual_current'
  | 'manual_from_message'
  | 'auto_threshold'
  | 'overflow_recovery';

export interface CompactionSurvivorFile {
  path: string;
  reason?: string;
  needsReRead?: boolean;
  survival?: 'path_only' | 'digest' | 'excerpt';
  digest?: string;
  excerpt?: string;
  metadata?: {
    size?: number;
    mtime?: number;
    readTime?: number;
    textLike?: boolean;
    truncated?: boolean;
    sensitive?: boolean;
  };
}

export interface CompactionSurvivorItem {
  label: string;
  detail: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface CompactionSurvivorManifest {
  sessionId?: string;
  source?: CompactionSource;
  anchorMessageId?: string;
  preserveRecentCount?: number;
  compactedMessageIds?: string[];
  preservedMessageIds?: string[];
  files?: CompactionSurvivorFile[];
  commands?: CompactionSurvivorItem[];
  errors?: CompactionSurvivorItem[];
  openWork?: CompactionSurvivorItem[];
  artifacts?: CompactionSurvivorFile[];
  archivedToolResults?: CompactionSurvivorItem[];
  dataFingerprint?: string;
}

export interface CompactionBlock {
  type: 'compaction';
  content: string;                // 摘要内容
  timestamp: number;
  compactedMessageCount: number;  // 被压缩的消息数量
  compactedTokenCount: number;    // 被压缩的 token 数量
  source?: CompactionSource;
  summaryVersion?: number;
  anchorMessageId?: string;
  preservedMessageIds?: string[];
  compactedMessageIds?: string[];
  survivorManifest?: CompactionSurvivorManifest;
  provider?: string;
  model?: string;
  warnings?: string[];
}

// Generative UI Artifact（可视化产物）
export interface Artifact {
  id: string;           // 唯一标识，如 'artifact_1'
  type: 'chart' | 'spreadsheet' | 'document' | 'generative_ui' | 'mermaid' | 'question_form';
  title?: string;       // 可视化标题
  content: string;      // chart JSON spec / HTML 源码 / question-form JSON 主体
  version: number;      // 版本号，用于追踪修改
  parentId?: string;    // 如果是更新，指向原始 artifact
}

// 内容块（保留 text 和 tool_call 的交错顺序）
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCallId: string };

export interface SkillMessageMetadata {
  skillName: string;
  phase: 'status' | 'instructions';
}

export interface ChannelMessageMetadata {
  platform: string;
  accountId: string;
  accountName?: string;
  chatId: string;
  chatType?: string;
  chatName?: string;
  messageId?: string;
}

export interface NeoTagMessageMetadata {
  workCardId?: string;
  approvedRevisionId?: string;
  runId?: string;
  contextPackId?: string;
  sourceConversationId?: string;
  sourceTurnId?: string;
  status?: 'queued' | 'working' | 'in_result_review' | 'failed';
}

export interface AgentTeamMessageMetadata {
  sessionId: string;
  runId: string;
  treeId: string;
  /** Legacy primary target. Multi-target Direct turns use the first stable target. */
  agentId: string;
  /** Canonical conversation message targets; per-agent delivery uses a separate ledger identity. */
  targetAgentIds?: string[];
}

export interface MessageMetadata {
  workbench?: WorkbenchMessageMetadata;
  skill?: SkillMessageMetadata;
  channel?: ChannelMessageMetadata;
  neoTag?: NeoTagMessageMetadata;
  agentTeam?: AgentTeamMessageMetadata;
  automation?: SessionAutomationMessageMetadata;
  turnQuality?: TurnQualitySummary;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  visibility?: MessageVisibility;
  hiddenByRewindId?: string;
  hiddenAt?: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  // 保留 text 和 tool_call 的原始交错顺序（向后兼容：缺失时 fallback 到 content + toolCalls）
  contentParts?: ContentPart[];
  // 多模态支持
  attachments?: MessageAttachment[];
  // Skill 系统支持 (Agent Skills 标准)
  // isMeta: true 表示消息不渲染到 UI，但会发送给模型
  isMeta?: boolean;
  // 消息来源追踪
  source?: MessageSource;
  // 推理模型的思考过程 (glm-4.7 等)
  reasoning?: string;
  // Subagent 追踪
  /** 父工具调用 ID，用于标识消息来自哪个 subagent */
  parentToolUseId?: string;
  /** Subagent 消息子类型 */
  subtype?: MessageSubtype;
  // Compaction 系统（上下文压缩摘要）
  compaction?: CompactionBlock;
  // Adaptive Thinking（交错思考）
  thinking?: string;
  // Effort 级别（Adaptive Thinking 思考深度）
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra_code';
  // Token usage from API response
  inputTokens?: number;
  outputTokens?: number;
  // ADR-019: 模型路由决策，供聊天 trace / replay 展示
  modelDecision?: ModelDecisionEventData;
  // Generative UI Artifacts（生成式 UI 产物追踪）
  artifacts?: Artifact[];
  // 附加消息元数据（workbench 上下文快照等）
  metadata?: MessageMetadata;
  // Anthropic prompt cache 标记 — 在 fork 共享前缀时设置
  cache_control?: { type: 'ephemeral' };
}

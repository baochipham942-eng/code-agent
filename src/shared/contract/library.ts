// ============================================================================
// Library Types - 项目资料库（LibraryItem + 会话上下文 pin）
// ============================================================================

/**
 * 资料条目类型
 * - upload: 用户上传的本地文件
 * - artifact: 会话/任务产物归档
 * - capture: 浏览器采集内容归档
 * - external_ref: 外部引用（URL 等，不落盘）
 */
/** 资料库支持的条目类型；UI 筛选和显示必须从此处推导。 */
export const LIBRARY_ITEM_KINDS = ['upload', 'artifact', 'capture', 'external_ref'] as const;

export type LibraryItemKind = (typeof LIBRARY_ITEM_KINDS)[number];

/**
 * 学习状态（N-LIBRARY-LEARN-STATUS）：条目登记后的解析/建索引生命周期。
 * - pending: 已登记，等待解析
 * - running: 解析进行中
 * - ready:   文本抽取完成，可检索/可给依据
 * - failed:  解析失败（learnError 带真实原因），可重试
 * 旧库迁移行视为 pending（无抽取文本，装 ready 就是假装已学习）。
 */
const LIBRARY_LEARN_STATUSES = ['pending', 'running', 'ready', 'failed'] as const;

export type LibraryLearnStatus = (typeof LIBRARY_LEARN_STATUSES)[number];

export function isLibraryLearnStatus(value: string): value is LibraryLearnStatus {
  return (LIBRARY_LEARN_STATUSES as readonly string[]).includes(value);
}

/**
 * 资料库条目
 */
export interface LibraryItem {
  id: string;
  /** null = 全局/未归类架 */
  projectId: string | null;
  title: string;
  kind: LibraryItemKind;
  /** 本地绝对路径或外部 URI */
  pathOrUri: string;
  /** 素材 | 草稿 | 定稿 | 证据 … */
  tags: string[];
  /** 一句话摘要，注入上下文索引用；正文按需 Read */
  summary?: string;
  sourceSessionId?: string;
  sourceRoleId?: string;
  /** 内容哈希，用于去重 */
  contentHash?: string;
  /** 学习状态；缺省（老客户端/旧 fixture）UI 按 pending，不得显示为「可用」 */
  learnStatus?: LibraryLearnStatus;
  /** failed 时的真实解析错误原因（不含任何 embedding 配置话术） */
  learnError?: string;
  /** 学习状态最近一次变更时间 */
  learnUpdatedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 新建/归档资料条目请求
 */
export interface LibraryItemCreateRequest {
  projectId?: string | null;
  title: string;
  kind: LibraryItemKind;
  pathOrUri: string;
  tags?: string[];
  summary?: string;
  sourceSessionId?: string;
  sourceRoleId?: string;
  contentHash?: string;
  /** 登记即 ready（无解析环节的条目，如 external_ref/capture）；缺省 pending 走学习管线 */
  learnStatus?: LibraryLearnStatus;
}

/**
 * 资料条目列表过滤
 */
export interface LibraryListOptions {
  /** 不传 = 全部；null = 仅全局架 */
  projectId?: string | null;
  kind?: LibraryItemKind;
  tag?: string;
  limit?: number;
  offset?: number;
}

/**
 * 会话上下文 pin：会话内被选中注入上下文的资料条目集合
 */
export interface SessionContextPin {
  sessionId: string;
  itemIds: string[];
  addedAt: number;
}

// ============================================================================
// 依据投影（N-LIBRARY-LEARN-STATUS ④）— 消费现有 citation 合同的 source/location，
// 把「引用了资料库条目」的 citation 投影成 条目 + 命中片段。不是第三套 chip：
// 入参直接来自 toolResult.metadata.citations（src/shared/contract/citation.ts）。
// ============================================================================

/** 从 Citation 摘出的定位字段（source 为本地路径或 URI） */
export interface LibraryEvidenceQuery {
  source: string;
  /** Citation.location，如 "line:42" / "lines:10-20" */
  location?: string;
  /** Citation.lineRange 结构化行号 */
  lineRange?: [number, number];
}

/** 命中片段：抽取文本（或文本型原件）中围绕定位的行窗口 */
interface LibraryEvidenceFragment {
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
}

/** 单条 citation 的依据投影；hit=false 时 fragment 必为空，绝不假装有依据 */
export interface LibraryEvidenceProjection {
  query: LibraryEvidenceQuery;
  hit: boolean;
  item?: LibraryItem;
  fragment?: LibraryEvidenceFragment | null;
  /** 未命中/无片段的真实原因（未命中条目 / 抽取未完成 / 解析失败原因） */
  reason?: string;
}

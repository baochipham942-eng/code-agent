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

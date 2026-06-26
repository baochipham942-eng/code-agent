// ============================================================================
// Protocol — GitHub 相关类型
// 原位置: src/main/services/github/prLinkService.ts
// ============================================================================

export interface PRContext {
  /** PR 基本信息 */
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  /** 分支信息 */
  headBranch: string;
  baseBranch: string;
  /** 状态 */
  state: 'open' | 'closed' | 'merged';
  /** 文件变更 */
  changedFiles: number;
  additions: number;
  deletions: number;
  /** 标签 */
  labels: string[];
  /** URL */
  url: string;
}

export interface ParsedPRUrl {
  owner: string;
  repo: string;
  number: number;
}

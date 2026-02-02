// ============================================================================
// PR Link Service - GitHub PR 关联服务
// ============================================================================
// 支持会话与 GitHub PR 关联，实现 --from-pr 恢复功能
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../infra/logger';
import type { PRLink } from '../../../shared/types/session';

const execAsync = promisify(exec);
const logger = createLogger('PRLinkService');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// PR Link Service
// ----------------------------------------------------------------------------

export class PRLinkService {
  /**
   * 解析 PR URL
   * 支持格式:
   * - https://github.com/owner/repo/pull/123
   * - github.com/owner/repo/pull/123
   * - owner/repo#123
   * - #123 (需要配合当前仓库)
   */
  parsePRUrl(url: string, currentRepo?: { owner: string; repo: string }): ParsedPRUrl | null {
    // 完整 URL 格式
    const fullUrlMatch = url.match(/(?:https?:\/\/)?github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
    if (fullUrlMatch) {
      return {
        owner: fullUrlMatch[1],
        repo: fullUrlMatch[2],
        number: parseInt(fullUrlMatch[3], 10),
      };
    }

    // owner/repo#123 格式
    const shortMatch = url.match(/^([^\/]+)\/([^#]+)#(\d+)$/);
    if (shortMatch) {
      return {
        owner: shortMatch[1],
        repo: shortMatch[2],
        number: parseInt(shortMatch[3], 10),
      };
    }

    // #123 格式 (需要当前仓库上下文)
    const numberMatch = url.match(/^#?(\d+)$/);
    if (numberMatch && currentRepo) {
      return {
        owner: currentRepo.owner,
        repo: currentRepo.repo,
        number: parseInt(numberMatch[1], 10),
      };
    }

    return null;
  }

  /**
   * 获取当前 Git 仓库的 owner/repo
   */
  async getCurrentRepo(): Promise<{ owner: string; repo: string } | null> {
    try {
      const { stdout } = await execAsync('git remote get-url origin');
      const url = stdout.trim();

      // SSH 格式: git@github.com:owner/repo.git
      const sshMatch = url.match(/git@github\.com:([^\/]+)\/([^\.]+)(?:\.git)?/);
      if (sshMatch) {
        return { owner: sshMatch[1], repo: sshMatch[2] };
      }

      // HTTPS 格式: https://github.com/owner/repo.git
      const httpsMatch = url.match(/github\.com\/([^\/]+)\/([^\.]+)(?:\.git)?/);
      if (httpsMatch) {
        return { owner: httpsMatch[1], repo: httpsMatch[2] };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * 使用 gh CLI 获取 PR 上下文
   */
  async fetchPRContext(owner: string, repo: string, number: number): Promise<PRContext | null> {
    try {
      const { stdout } = await execAsync(
        `gh pr view ${number} --repo ${owner}/${repo} --json number,title,body,headRefName,baseRefName,state,changedFiles,additions,deletions,labels,url`
      );

      const data = JSON.parse(stdout);

      return {
        owner,
        repo,
        number: data.number,
        title: data.title,
        body: data.body || '',
        headBranch: data.headRefName,
        baseBranch: data.baseRefName,
        state: data.state.toLowerCase() as 'open' | 'closed' | 'merged',
        changedFiles: data.changedFiles,
        additions: data.additions,
        deletions: data.deletions,
        labels: data.labels?.map((l: { name: string }) => l.name) || [],
        url: data.url,
      };
    } catch (error) {
      logger.error('Failed to fetch PR context', { owner, repo, number, error });
      return null;
    }
  }

  /**
   * 获取 PR 的文件变更列表
   */
  async fetchPRFiles(owner: string, repo: string, number: number): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        `gh pr view ${number} --repo ${owner}/${repo} --json files --jq '.files[].path'`
      );
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * 构建 PR 上下文 Prompt 片段
   */
  buildPRPrompt(context: PRContext, files?: string[]): string {
    const lines: string[] = [];

    lines.push(`## GitHub PR Context`);
    lines.push('');
    lines.push(`**PR #${context.number}**: ${context.title}`);
    lines.push(`**Repository**: ${context.owner}/${context.repo}`);
    lines.push(`**Branch**: ${context.headBranch} → ${context.baseBranch}`);
    lines.push(`**Status**: ${context.state}`);
    lines.push(`**Changes**: +${context.additions} / -${context.deletions} in ${context.changedFiles} files`);

    if (context.labels.length > 0) {
      lines.push(`**Labels**: ${context.labels.join(', ')}`);
    }

    lines.push('');

    if (context.body) {
      lines.push('### Description');
      lines.push('');
      // Truncate long descriptions
      const maxLength = 1000;
      if (context.body.length > maxLength) {
        lines.push(context.body.substring(0, maxLength) + '...');
      } else {
        lines.push(context.body);
      }
      lines.push('');
    }

    if (files && files.length > 0) {
      lines.push('### Changed Files');
      lines.push('');
      // Show first 20 files
      const displayFiles = files.slice(0, 20);
      for (const file of displayFiles) {
        lines.push(`- \`${file}\``);
      }
      if (files.length > 20) {
        lines.push(`- ... and ${files.length - 20} more files`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 创建 PRLink 对象
   */
  createPRLink(context: PRContext): PRLink {
    return {
      owner: context.owner,
      repo: context.repo,
      number: context.number,
      title: context.title,
      branch: context.headBranch,
      linkedAt: Date.now(),
    };
  }

  /**
   * 格式化 PR 标识符
   */
  formatPRIdentifier(link: PRLink): string {
    return `${link.owner}/${link.repo}#${link.number}`;
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let prLinkServiceInstance: PRLinkService | null = null;

export function getPRLinkService(): PRLinkService {
  if (!prLinkServiceInstance) {
    prLinkServiceInstance = new PRLinkService();
  }
  return prLinkServiceInstance;
}

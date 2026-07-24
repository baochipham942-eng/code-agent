// ============================================================================
// AGENTS.md Hooks - 会话开始时注入 AGENTS.md 指令
// ============================================================================

import type { SessionContext, HookExecutionResult } from '../../protocol/events';
import path from 'path';
import { discoverAgentFilesCached } from '../../context/agentsDiscovery';
import { createLogger } from '../../services/infra/logger';
import { getContextHealthService } from '../../context/contextHealthService';
import { estimateTokens } from '../../context/tokenEstimator';
import { isPathWithinRoot } from '../../runtime/workspaceScope';

const logger = createLogger('AgentsHooks');
const MAX_AGENT_FILES_TO_INJECT = 12;
const MAX_AGENT_INSTRUCTION_CHARS = 24_000;

// ----------------------------------------------------------------------------
// Session Start: AGENTS.md Inject
// ----------------------------------------------------------------------------

/**
 * 会话开始时注入 AGENTS.md 指令
 *
 * 自动发现项目目录中的 AGENTS.md、CLAUDE.md 等文件，
 * 并将其内容注入到 Agent 的上下文中。
 */
export async function sessionStartAgentsInjectHook(
  context: SessionContext,
  maxDepth: number = 3,
  includeParents: boolean = true
): Promise<HookExecutionResult> {
  const startTime = Date.now();

  try {
    const workingDirectory = path.resolve(context.workingDirectory || '');
    const rootDirectory = path.parse(workingDirectory).root;

    // Guardrail: if the hook is accidentally rooted at "/" we would sweep
    // unrelated projects and personal instruction files into the session.
    if (!workingDirectory || workingDirectory === rootDirectory) {
      logger.warn('Skipping AGENTS.md injection for unsafe working directory', {
        workingDirectory: context.workingDirectory,
      });
      return {
        action: 'continue',
        duration: Date.now() - startTime,
      };
    }

    // 使用缓存的发现服务。把 hook 配置的 maxDepth 真正传到扫描层，避免先全量扫再过滤。
    const result = await discoverAgentFilesCached(workingDirectory, {
      maxDepth,
      maxFiles: MAX_AGENT_FILES_TO_INJECT,
    });

    if (result.files.length === 0) {
      logger.debug('No AGENTS.md files found', {
        workingDirectory,
      });
      return {
        action: 'continue',
        duration: Date.now() - startTime,
      };
    }

    // 构建注入内容
    const sections: string[] = [];

    // 按优先级排序：根目录的文件优先，AGENTS.md 优先于 CLAUDE.md
    const sortedFiles = [...result.files].sort((a, b) => {
      // 根目录优先
      const aIsRoot = a.directory === '.';
      const bIsRoot = b.directory === '.';
      if (aIsRoot !== bIsRoot) return aIsRoot ? -1 : 1;

      // AGENTS.md 优先于 CLAUDE.md
      const aIsAgents = a.relativePath.toLowerCase().includes('agents');
      const bIsAgents = b.relativePath.toLowerCase().includes('agents');
      if (aIsAgents !== bIsAgents) return aIsAgents ? -1 : 1;

      // 按路径深度排序
      const aDepth = a.relativePath.split('/').length;
      const bDepth = b.relativePath.split('/').length;
      return aDepth - bDepth;
    });

    // 根据深度和父目录设置过滤
    const filteredFiles = sortedFiles.filter((file) => {
      const depth = file.relativePath.split('/').length - 1;
      if (depth > maxDepth) return false;

      // 检查是否是父目录
      const isParent = !isPathWithinRoot(file.absolutePath, workingDirectory);
      if (isParent && !includeParents) return false;

      return true;
    });

    let injectedChars = 0;
    let truncated = result.truncated || filteredFiles.length > MAX_AGENT_FILES_TO_INJECT;

    for (const file of filteredFiles.slice(0, MAX_AGENT_FILES_TO_INJECT)) {
      const header = `# ${file.relativePath}`;
      const block = `${header}\n\n${file.content}`;
      const remainingChars = MAX_AGENT_INSTRUCTION_CHARS - injectedChars;
      if (remainingChars <= 0) {
        truncated = true;
        break;
      }
      if (block.length > remainingChars) {
        sections.push(`${block.slice(0, remainingChars)}\n\n[AGENTS.md instructions truncated]`);
        truncated = true;
        break;
      }
      sections.push(block);
      injectedChars += block.length;
    }

    if (sections.length === 0) {
      return {
        action: 'continue',
        duration: Date.now() - startTime,
      };
    }

    const injectedContent = [
      '<agents-instructions>',
      'The following AGENTS.md instructions were discovered in the project:',
      '',
      ...sections,
      '</agents-instructions>',
    ].join('\n');

    logger.info('AGENTS.md instructions injected', {
      fileCount: filteredFiles.length,
      files: filteredFiles.map((f) => f.relativePath),
      contentLength: injectedContent.length,
      truncated,
    });

    // 上报 rules 维度的 token 贡献（set 模式：session 内只有一次 AGENTS 注入）
    try {
      getContextHealthService().recordSourceContribution(
        context.sessionId,
        { type: 'rule', name: 'agents-instructions' },
        estimateTokens(injectedContent),
        'set',
      );
    } catch (err) {
      logger.debug('Failed to report agents-instructions token contribution', { err });
    }

    return {
      action: 'continue',
      message: injectedContent,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    logger.error('Failed to inject AGENTS.md instructions', { error });
    return {
      action: 'continue', // 不阻止会话，只是跳过注入
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime,
    };
  }
}

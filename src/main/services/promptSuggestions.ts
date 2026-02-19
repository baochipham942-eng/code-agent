// ============================================================================
// Prompt Suggestions Service - 智能提示建议
// ============================================================================

import { execSync } from 'child_process';
import { createLogger } from './infra/logger';

const logger = createLogger('PromptSuggestions');

export interface PromptSuggestion {
  id: string;
  text: string;
  source: 'git' | 'history' | 'files';
}

export async function getPromptSuggestions(
  workingDirectory: string,
): Promise<PromptSuggestion[]> {
  const suggestions: PromptSuggestion[] = [];

  // Source 1: Git status
  try {
    const gitStatus = execSync('git status --porcelain', {
      cwd: workingDirectory,
      timeout: 3000,
      encoding: 'utf-8',
    }).trim();

    if (gitStatus) {
      const changedFiles = gitStatus.split('\n').length;
      suggestions.push({
        id: 'git-commit',
        text: `提交当前 ${changedFiles} 个文件的修改`,
        source: 'git',
      });
    }

    const gitLog = execSync('git log --oneline -3 2>/dev/null', {
      cwd: workingDirectory,
      timeout: 3000,
      encoding: 'utf-8',
    }).trim();

    if (gitLog) {
      suggestions.push({
        id: 'git-review',
        text: '检查最近的代码变更',
        source: 'git',
      });
    }
  } catch {
    // not a git repo or git not available
  }

  // Source 2: Recently modified files
  try {
    const recentFiles = execSync(
      'find . -maxdepth 3 \\( -name "*.ts" -o -name "*.tsx" \\) -newer . -not -path "*/node_modules/*" 2>/dev/null | head -5',
      {
        cwd: workingDirectory,
        timeout: 3000,
        encoding: 'utf-8',
      }
    ).trim();

    if (recentFiles) {
      const firstFile = recentFiles.split('\n')[0]?.replace('./', '');
      if (firstFile) {
        suggestions.push({
          id: 'file-review',
          text: `检查 ${firstFile} 的实现`,
          source: 'files',
        });
      }
    }
  } catch {
    // ignore
  }

  // Source 3: Common suggestions
  suggestions.push({
    id: 'explain',
    text: '解释这个项目的结构',
    source: 'history',
  });

  return suggestions.slice(0, 5);
}

// ============================================================================
// Bash Summarizer - Smart summaries for bash command output
// ============================================================================

import type { ToolCall } from '@shared/types';

export function summarizeBash(toolCall: ToolCall): string | null {
  const output = toolCall.result?.output;
  if (!output) return 'Done';

  const outputStr = String(output).trim();
  const lines = outputStr.split('\n');

  // Extract command for context
  const command = String(toolCall.arguments?.command || '');

  // npm test output
  if (command.includes('npm test') || command.includes('jest') || command.includes('vitest')) {
    const passMatch = outputStr.match(/(\d+)\s*pass/i);
    const failMatch = outputStr.match(/(\d+)\s*fail/i);
    if (passMatch || failMatch) {
      const parts = [];
      if (passMatch) parts.push(`${passMatch[1]} passed`);
      if (failMatch) parts.push(`${failMatch[1]} failed`);
      return parts.join(', ');
    }
  }

  // npm install output
  if (command.includes('npm install') || command.includes('npm i ')) {
    const addedMatch = outputStr.match(/added (\d+) packages/);
    if (addedMatch) {
      return `added ${addedMatch[1]} packages`;
    }
    const upToDateMatch = outputStr.match(/up to date/i);
    if (upToDateMatch) {
      return 'up to date';
    }
  }

  // npm run build
  if (command.includes('npm run build') || command.includes('npm build')) {
    if (outputStr.includes('successfully') || outputStr.includes('Done in')) {
      return 'Build succeeded';
    }
  }

  // git status
  if (command.includes('git status')) {
    if (outputStr.includes('nothing to commit')) {
      return 'Clean';
    }
    const modifiedMatch = outputStr.match(/modified:\s+(\d+)/);
    if (modifiedMatch) {
      return `${modifiedMatch[1]} modified`;
    }
    if (outputStr.includes('Changes not staged')) {
      return 'Uncommitted changes';
    }
  }

  // git commit
  if (command.includes('git commit')) {
    const commitMatch = outputStr.match(/\[[\w-]+\s+([a-f0-9]+)\]/);
    if (commitMatch) {
      return `Committed ${commitMatch[1].slice(0, 7)}`;
    }
  }

  // git push
  if (command.includes('git push')) {
    if (outputStr.includes('Everything up-to-date')) {
      return 'Up to date';
    }
    if (outputStr.includes('->')) {
      return 'Pushed';
    }
  }

  // tsc / typecheck
  if (command.includes('tsc') || command.includes('typecheck')) {
    if (outputStr.length === 0 || outputStr.includes('0 errors')) {
      return 'No errors';
    }
    const errorMatch = outputStr.match(/(\d+)\s*error/i);
    if (errorMatch) {
      return `${errorMatch[1]} errors`;
    }
  }

  // ls output - count files
  if (command.match(/^ls(\s|$)/)) {
    const items = lines.filter(l => l.trim().length > 0);
    if (items.length <= 5) {
      return items.join(', ');
    }
    return `${items.length} items`;
  }

  // pwd output
  if (command === 'pwd') {
    return shortenPath(outputStr);
  }

  // Short output - display directly
  if (lines.length === 1 && lines[0].length < 60) {
    return lines[0];
  }

  // Multi-line output - show line count
  return `${lines.length} lines`;
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-2).join('/');
}

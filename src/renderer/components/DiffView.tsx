// ============================================================================
// DiffView - 代码差异可视化组件
// ============================================================================

import React, { useMemo } from 'react';
import * as Diff from 'diff';

interface DiffViewProps {
  oldText: string;
  newText: string;
  fileName?: string;
  className?: string;
}

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged' | 'header';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

/**
 * DiffView 组件 - 显示代码差异的 unified diff 格式
 */
export const DiffView: React.FC<DiffViewProps> = ({
  oldText,
  newText,
  fileName,
  className = '',
}) => {
  const diffLines = useMemo(() => {
    const changes = Diff.diffLines(oldText, newText);
    const lines: DiffLine[] = [];

    let oldLineNum = 1;
    let newLineNum = 1;

    // 添加文件头
    if (fileName) {
      lines.push({
        type: 'header',
        content: `--- a/${fileName}`,
      });
      lines.push({
        type: 'header',
        content: `+++ b/${fileName}`,
      });
    }

    for (const change of changes) {
      const changeLines = change.value.split('\n');
      // 移除最后一个空行（如果是换行符结尾）
      if (changeLines[changeLines.length - 1] === '') {
        changeLines.pop();
      }

      for (const line of changeLines) {
        if (change.added) {
          lines.push({
            type: 'added',
            content: line,
            newLineNum: newLineNum++,
          });
        } else if (change.removed) {
          lines.push({
            type: 'removed',
            content: line,
            oldLineNum: oldLineNum++,
          });
        } else {
          lines.push({
            type: 'unchanged',
            content: line,
            oldLineNum: oldLineNum++,
            newLineNum: newLineNum++,
          });
        }
      }
    }

    return lines;
  }, [oldText, newText, fileName]);

  // 计算统计信息
  const stats = useMemo(() => {
    const added = diffLines.filter((l) => l.type === 'added').length;
    const removed = diffLines.filter((l) => l.type === 'removed').length;
    return { added, removed };
  }, [diffLines]);

  // 如果没有变化
  if (stats.added === 0 && stats.removed === 0) {
    return (
      <div className={`text-gray-500 text-sm p-2 ${className}`}>
        无变化
      </div>
    );
  }

  return (
    <div className={`diff-view rounded-lg overflow-hidden ${className}`}>
      {/* 统计栏 */}
      <div className="diff-stats flex items-center gap-3 px-3 py-2 bg-[var(--color-elevated)] border-b border-[var(--color-border)]">
        {fileName && (
          <span className="text-gray-400 text-xs font-mono truncate flex-1">
            {fileName}
          </span>
        )}
        <div className="flex items-center gap-2 text-xs">
          {stats.added > 0 && (
            <span className="text-emerald-400">+{stats.added}</span>
          )}
          {stats.removed > 0 && (
            <span className="text-rose-400">-{stats.removed}</span>
          )}
        </div>
      </div>

      {/* Diff 内容 */}
      <div className="diff-content overflow-x-auto bg-[var(--color-surface)]">
        <table className="w-full text-xs font-mono">
          <tbody>
            {diffLines.map((line, index) => (
              <DiffLineRow key={index} line={line} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * 单行 Diff 渲染
 */
const DiffLineRow: React.FC<{ line: DiffLine }> = ({ line }) => {
  const getLineClass = () => {
    switch (line.type) {
      case 'added':
        return 'bg-emerald-500/10';
      case 'removed':
        return 'bg-rose-500/10';
      case 'header':
        return 'bg-[var(--color-elevated)]';
      default:
        return '';
    }
  };

  const getGutterClass = () => {
    switch (line.type) {
      case 'added':
        return 'text-emerald-500 bg-emerald-500/20';
      case 'removed':
        return 'text-rose-500 bg-rose-500/20';
      case 'header':
        return 'text-gray-500 bg-[var(--color-elevated)]';
      default:
        return 'text-gray-600 bg-[var(--color-deep)]';
    }
  };

  const getPrefix = () => {
    switch (line.type) {
      case 'added':
        return '+';
      case 'removed':
        return '-';
      case 'header':
        return '';
      default:
        return ' ';
    }
  };

  const getContentClass = () => {
    switch (line.type) {
      case 'added':
        return 'text-emerald-300';
      case 'removed':
        return 'text-rose-300';
      case 'header':
        return 'text-gray-500 font-bold';
      default:
        return 'text-gray-400';
    }
  };

  // 头部行特殊处理
  if (line.type === 'header') {
    return (
      <tr className={getLineClass()}>
        <td colSpan={3} className={`px-3 py-0.5 ${getContentClass()}`}>
          {line.content}
        </td>
      </tr>
    );
  }

  return (
    <tr className={getLineClass()}>
      {/* 行号列 */}
      <td className={`w-10 text-right px-2 py-0.5 select-none ${getGutterClass()}`}>
        {line.oldLineNum ?? ''}
      </td>
      <td className={`w-10 text-right px-2 py-0.5 select-none ${getGutterClass()}`}>
        {line.newLineNum ?? ''}
      </td>
      {/* 内容列 */}
      <td className={`px-2 py-0.5 whitespace-pre ${getContentClass()}`}>
        <span className="select-none opacity-50 mr-1">{getPrefix()}</span>
        {line.content}
      </td>
    </tr>
  );
};

/**
 * 简化版 Diff 预览 - 仅显示变化行数
 */
export const DiffPreview: React.FC<{
  oldText: string;
  newText: string;
  onClick?: (e?: React.MouseEvent) => void;
}> = ({ oldText, newText, onClick }) => {
  const stats = useMemo(() => {
    const changes = Diff.diffLines(oldText, newText);
    let added = 0;
    let removed = 0;

    for (const change of changes) {
      const lines = change.value.split('\n').filter((l) => l !== '').length;
      if (change.added) {
        added += lines;
      } else if (change.removed) {
        removed += lines;
      }
    }

    return { added, removed };
  }, [oldText, newText]);

  if (stats.added === 0 && stats.removed === 0) {
    return <span className="text-gray-500">无变化</span>;
  }

  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-xs hover:bg-[var(--color-elevated)] px-2 py-1 rounded transition-colors"
    >
      {stats.added > 0 && (
        <span className="text-emerald-400">+{stats.added}</span>
      )}
      {stats.removed > 0 && (
        <span className="text-rose-400">-{stats.removed}</span>
      )}
      <span className="text-gray-500">行</span>
    </button>
  );
};

export default DiffView;

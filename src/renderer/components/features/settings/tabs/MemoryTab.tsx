// ============================================================================
// MemoryTab - Memory Management Settings Tab
// ============================================================================

import React, { useState, useEffect, useMemo } from 'react';
import {
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  Download,
  Upload,
  Trash2,
  AlertCircle,
  CheckCircle,
} from 'lucide-react';
import { Button, Input } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import { MemoryCard } from './MemoryCard';
import { MemoryEditModal } from './MemoryEditModal';
import { KeyDecisionsPanel } from './KeyDecisionsPanel';
import { useI18n } from '../../../../hooks/useI18n';
import { createLogger } from '../../../../utils/logger';
import type { MemoryItem, MemoryCategory, MemoryStats } from '@shared/types';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';

const logger = createLogger('MemoryTab');

// Category info with icons
const CATEGORIES: Array<{
  key: MemoryCategory;
  icon: string;
  labelKey: string;
  descKey: string;
}> = [
  { key: 'about_me', icon: '👤', labelKey: 'aboutMe', descKey: 'aboutMeDesc' },
  { key: 'preference', icon: '⭐', labelKey: 'preference', descKey: 'preferenceDesc' },
  { key: 'frequent_info', icon: '📋', labelKey: 'frequentInfo', descKey: 'frequentInfoDesc' },
  { key: 'learned', icon: '💡', labelKey: 'learned', descKey: 'learnedDesc' },
];

// ============================================================================
// Component
// ============================================================================

export const MemoryTab: React.FC = () => {
  const { t } = useI18n();
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<MemoryCategory>>(
    new Set(['about_me', 'preference', 'frequent_info', 'learned'])
  );
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Edit modal state
  const [editingMemory, setEditingMemory] = useState<MemoryItem | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);

  // Delete confirmation state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingCategory, setClearingCategory] = useState<MemoryCategory | null>(null);

  // Load memories
  const loadMemories = async () => {
    try {
      setIsLoading(true);
      const [memoriesResult, statsResult] = await Promise.all([
        ipcService.invoke(IPC_CHANNELS.MEMORY, { action: 'list' }) as Promise<{ success: boolean; data?: MemoryItem[] }>,
        ipcService.invoke(IPC_CHANNELS.MEMORY, { action: 'getStats' }) as Promise<{ success: boolean; data?: MemoryStats }>,
      ]);
      if (memoriesResult?.success && memoriesResult.data) {
        setMemories(memoriesResult.data);
      }
      if (statsResult?.success && statsResult.data) {
        setStats(statsResult.data);
      }
    } catch (error) {
      logger.error('Failed to load memories', error);
      setMessage({ type: 'error', text: '加载记忆失败' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadMemories();
  }, []);

  // Filter memories by search query
  const filteredMemories = useMemo(() => {
    if (!searchQuery.trim()) return memories;
    const query = searchQuery.toLowerCase();
    return memories.filter(
      (m) =>
        m.content.toLowerCase().includes(query) ||
        m.tags?.some((tag: string) => tag.toLowerCase().includes(query))
    );
  }, [memories, searchQuery]);

  // Group memories by category
  const memoriesByCategory = useMemo(() => {
    const grouped: Record<MemoryCategory, MemoryItem[]> = {
      about_me: [],
      preference: [],
      frequent_info: [],
      learned: [],
    };
    for (const memory of filteredMemories) {
      if (grouped[memory.category]) {
        grouped[memory.category].push(memory);
      }
    }
    return grouped;
  }, [filteredMemories]);

  // Toggle category expansion
  const toggleCategory = (category: MemoryCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  // Handle edit
  const handleEdit = (memory: MemoryItem) => {
    setEditingMemory(memory);
    setIsEditModalOpen(true);
  };

  // Handle save edit
  const handleSaveEdit = async (id: string, content: string) => {
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.MEMORY, {
        action: 'update',
        id,
        content,
      });
      if (result?.success) {
        setMessage({ type: 'success', text: '记忆已更新' });
        await loadMemories();
      } else {
        setMessage({ type: 'error', text: result?.error || '更新失败' });
      }
    } catch (error) {
      logger.error('Failed to update memory', error);
      setMessage({ type: 'error', text: '更新失败' });
    }
    setIsEditModalOpen(false);
    setEditingMemory(null);
  };

  // Handle delete
  const handleDelete = async (id: string) => {
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.MEMORY, {
        action: 'delete',
        id,
      });
      if (result?.success) {
        setMessage({ type: 'success', text: '记忆已删除' });
        await loadMemories();
      } else {
        setMessage({ type: 'error', text: result?.error || '删除失败' });
      }
    } catch (error) {
      logger.error('Failed to delete memory', error);
      setMessage({ type: 'error', text: '删除失败' });
    }
    setDeletingId(null);
  };

  // Handle clear category
  const handleClearCategory = async (category: MemoryCategory) => {
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.MEMORY, {
        action: 'deleteByCategory',
        category,
      }) as { success: boolean; data?: { deleted: number }; error?: string } | undefined;
      if (result?.success) {
        setMessage({ type: 'success', text: `已清空 ${result.data?.deleted || 0} 条记忆` });
        await loadMemories();
      } else {
        setMessage({ type: 'error', text: result?.error || '清空失败' });
      }
    } catch (error) {
      logger.error('Failed to clear category', error);
      setMessage({ type: 'error', text: '清空失败' });
    }
    setClearingCategory(null);
  };

  // Handle export
  const handleExport = async () => {
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.MEMORY, {
        action: 'export',
      });
      if (result?.success && result.data) {
        const blob = new Blob([JSON.stringify(result.data, null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `memories-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setMessage({ type: 'success', text: '导出成功' });
      } else {
        setMessage({ type: 'error', text: result?.error || '导出失败' });
      }
    } catch (error) {
      logger.error('Failed to export memories', error);
      setMessage({ type: 'error', text: '导出失败' });
    }
  };

  // Handle import
  const handleImport = async () => {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const data = JSON.parse(event.target?.result as string);
            const result = await ipcService.invoke(IPC_CHANNELS.MEMORY, {
              action: 'import',
              data,
            }) as { success: boolean; data?: { imported: number }; error?: string } | undefined;
            if (result?.success) {
              setMessage({ type: 'success', text: `导入成功: ${result.data?.imported || 0} 条` });
              await loadMemories();
            } else {
              setMessage({ type: 'error', text: result?.error || '导入失败' });
            }
          } catch {
            setMessage({ type: 'error', text: '无效的 JSON 文件' });
          }
        };
        reader.readAsText(file);
      };
      input.click();
    } catch (error) {
      logger.error('Failed to import memories', error);
      setMessage({ type: 'error', text: '导入失败' });
    }
  };

  // Get category label
  const getCategoryLabel = (key: string) => {
    const labels: Record<string, string> = {
      aboutMe: '关于我',
      aboutMeDesc: '身份、角色、沟通风格',
      preference: '我的偏好',
      preferenceDesc: '格式、风格、工具偏好',
      frequentInfo: '常用信息',
      frequentInfoDesc: '邮箱、模板、常用数据',
      learned: '学到的经验',
      learnedDesc: 'AI 观察到的模式和习惯',
    };
    return (t.memory as Record<string, string>)?.[key] || labels[key] || key;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

      <WebModeBanner />
  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-1">
          {(t.memory as Record<string, string>)?.title || '记忆管理'}
        </h3>
        <p className="text-xs text-zinc-400">
          {(t.memory as Record<string, string>)?.description ||
            '查看和管理 AI 记住的关于你的信息'}
        </p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-2">
          <div className="bg-zinc-800 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-zinc-200">{stats.total}</div>
            <div className="text-xs text-zinc-400">总计</div>
          </div>
          <div className="bg-zinc-800 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-indigo-400">{stats.explicitCount}</div>
            <div className="text-xs text-zinc-400">手动添加</div>
          </div>
          <div className="bg-zinc-800 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-cyan-400">{stats.learnedCount}</div>
            <div className="text-xs text-zinc-400">自动学习</div>
          </div>
          <div className="bg-zinc-800 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-amber-400">{stats.recentlyAdded}</div>
            <div className="text-xs text-zinc-400">近 7 天</div>
          </div>
        </div>
      )}

      {/* Search & Actions */}
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索记忆..."
            className="pl-9"
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={isWebMode()}
          onClick={handleExport}
          title="导出"
        >
          <Download className="w-4 h-4" />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={isWebMode()}
          onClick={handleImport}
          title="导入"
        >
          <Upload className="w-4 h-4" />
        </Button>
      </div>

      {/* Category Lists */}
      <div className="space-y-2 max-h-[280px] overflow-y-auto">
        {CATEGORIES.map((cat) => {
          const categoryMemories = memoriesByCategory[cat.key];
          const isExpanded = expandedCategories.has(cat.key);
          const count = categoryMemories.length;

          return (
            <div key={cat.key} className="bg-zinc-800 rounded-lg overflow-hidden">
              {/* Category Header */}
              <button
                onClick={() => toggleCategory(cat.key)}
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-800 transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-zinc-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-zinc-400" />
                )}
                <span className="text-base">{cat.icon}</span>
                <span className="text-sm font-medium text-zinc-200 flex-1 text-left">
                  {getCategoryLabel(cat.labelKey)}
                </span>
                <span className="text-xs text-zinc-500">{count} 条</span>
                {count > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setClearingCategory(cat.key);
                    }}
                    className="p-1 hover:bg-zinc-600 rounded text-zinc-500 hover:text-red-400 transition-colors"
                    title="清空分类"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </button>

              {/* Category Content */}
              {isExpanded && (
                <div className="px-3 pb-2 space-y-1">
                  {count === 0 ? (
                    <p className="text-xs text-zinc-500 py-2 text-center">
                      暂无记忆
                    </p>
                  ) : (
                    categoryMemories.map((memory) => (
                      <MemoryCard
                        key={memory.id}
                        memory={memory}
                        onEdit={() => handleEdit(memory)}
                        onDelete={() => setDeletingId(memory.id)}
                        isDeleting={deletingId === memory.id}
                        onConfirmDelete={() => handleDelete(memory.id)}
                        onCancelDelete={() => setDeletingId(null)}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Key Decisions Panel */}
      <KeyDecisionsPanel />

      {/* Clear Category Confirmation */}
      {clearingCategory && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setClearingCategory(null)}
          />
          <div className="relative bg-zinc-900 rounded-lg p-4 max-w-sm border border-zinc-700">
            <h4 className="text-sm font-medium text-zinc-200 mb-2">确认清空</h4>
            <p className="text-xs text-zinc-400 mb-4">
              确定要清空「
              {CATEGORIES.find((c) => c.key === clearingCategory)?.icon}{' '}
              {getCategoryLabel(
                CATEGORIES.find((c) => c.key === clearingCategory)?.labelKey || ''
              )}
              」分类下的所有记忆吗？此操作不可恢复。
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setClearingCategory(null)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={isWebMode()}
                onClick={() => handleClearCategory(clearingCategory)}
              >
                清空
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Message */}
      {message && (
        <div
          className={`flex items-center gap-2 p-2 rounded-lg text-xs ${
            message.type === 'success'
              ? 'bg-green-500/10 text-green-400'
              : 'bg-red-500/10 text-red-400'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          <span>{message.text}</span>
        </div>
      )}

      {/* Edit Modal */}
      {editingMemory && (
        <MemoryEditModal
          isOpen={isEditModalOpen}
          memory={editingMemory}
          onClose={() => {
            setIsEditModalOpen(false);
            setEditingMemory(null);
          }}
          onSave={handleSaveEdit}
        />
      )}
    </div>
  );
};

// ============================================================================
// CapturePanel - 知识库采集面板（主面板）
// ============================================================================

import React, { useEffect, useMemo, useCallback } from 'react';
import { Search, X, Loader2, BookOpen, Globe, MessageCircle, FolderOpen, FileText, Plus, Upload } from 'lucide-react';
import { useCaptureStore } from '../../../stores/captureStore';
import { useAppStore } from '../../../stores/appStore';
import { CaptureCard } from './CaptureCard';
import { CaptureDetail } from './CaptureDetail';
import { CaptureAddDialog } from './CaptureAddDialog';
import type { CaptureSource } from '@shared/types/capture';

const SOURCE_FILTERS: Array<{ key: CaptureSource | 'all'; label: string; icon: React.ReactNode }> = [
  { key: 'all', label: '全部', icon: <BookOpen className="w-3.5 h-3.5" /> },
  { key: 'browser_extension', label: '网页', icon: <Globe className="w-3.5 h-3.5" /> },
  { key: 'local_file', label: '文件', icon: <FolderOpen className="w-3.5 h-3.5" /> },
  { key: 'wechat', label: '微信', icon: <MessageCircle className="w-3.5 h-3.5" /> },
  { key: 'manual', label: '手动', icon: <FileText className="w-3.5 h-3.5" /> },
];

export const CapturePanel: React.FC = () => {
  const { setShowCapturePanel } = useAppStore();
  const {
    items,
    searchResults,
    stats,
    isLoading,
    searchQuery,
    filterSource,
    selectedItemId,
    isImporting,
    setSearchQuery,
    setFilterSource,
    setSelectedItemId,
    setAddDialogOpen,
    loadItems,
    searchItems,
    deleteItem,
    loadStats,
    importFiles,
  } = useCaptureStore();

  // 初始化加载
  useEffect(() => {
    loadItems();
    loadStats();
  }, [loadItems, loadStats]);

  // 过滤源切换时重新加载
  useEffect(() => {
    loadItems();
  }, [filterSource, loadItems]);

  // 搜索（带防抖）
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery.trim()) {
        searchItems(searchQuery);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchItems]);

  // 显示列表：有搜索时显示搜索结果，否则显示全部
  const displayItems = useMemo(() => {
    if (searchQuery.trim() && searchResults.length > 0) {
      return searchResults.map(r => r.item);
    }
    return items;
  }, [items, searchResults, searchQuery]);

  // 选中项
  const selectedItem = useMemo(() => {
    if (!selectedItemId) return null;
    return displayItems.find(i => i.id === selectedItemId) || null;
  }, [displayItems, selectedItemId]);

  const handleDelete = useCallback((id: string) => {
    deleteItem(id);
  }, [deleteItem]);

  return (
    <div className="fixed inset-0 z-50 flex bg-black/60" onClick={() => setShowCapturePanel(false)}>
      <div
        className="m-auto w-[900px] h-[600px] bg-[#1a1a1f] rounded-xl border border-zinc-800 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-medium text-zinc-200">知识库</h2>
            <span className="text-xs text-zinc-500">
              {stats?.total ?? displayItems.length} 项
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setAddDialogOpen(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-cyan-300 rounded-md hover:bg-zinc-800 transition-colors"
              title="手动添加"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>添加</span>
            </button>
            <button
              onClick={importFiles}
              disabled={isImporting}
              className="flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-cyan-300 rounded-md hover:bg-zinc-800 transition-colors disabled:opacity-50"
              title="导入本地文件"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>{isImporting ? '导入中...' : '导入'}</span>
            </button>
            <button
              onClick={() => setShowCapturePanel(false)}
              className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors ml-2"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 搜索 + 筛选 */}
        <div className="px-4 py-2 border-b border-zinc-800/50 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索采集内容..."
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-zinc-800/50 border border-zinc-700/50 rounded-md text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
            />
          </div>
          <div className="flex items-center gap-1">
            {SOURCE_FILTERS.map(f => (
              <button
                key={f.key}
                onClick={() => setFilterSource(f.key)}
                className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${
                  filterSource === f.key
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-zinc-500 hover:bg-zinc-800'
                }`}
              >
                {f.icon}
                <span>{f.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 内容区 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 列表 */}
          <div className="w-[360px] border-r border-zinc-800 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
              </div>
            ) : displayItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <BookOpen className="w-8 h-8 text-zinc-600 mb-3" />
                <p className="text-sm text-zinc-400 mb-1">暂无采集内容</p>
                <p className="text-xs text-zinc-500">
                  点击上方"添加"手动添加，或"导入"导入本地文件
                </p>
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {displayItems.map(item => (
                  <CaptureCard
                    key={item.id}
                    item={item}
                    isSelected={selectedItemId === item.id}
                    onSelect={setSelectedItemId}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 详情 */}
          <div className="flex-1">
            {selectedItem ? (
              <CaptureDetail
                item={selectedItem}
                onClose={() => setSelectedItemId(null)}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
                选择一项查看详情
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 手动添加对话框 */}
      <CaptureAddDialog />
    </div>
  );
};

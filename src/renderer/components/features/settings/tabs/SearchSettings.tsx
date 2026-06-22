// ============================================================================
// SearchSettings - 搜索 provider 配置（多源选择 + 优先级）
// 阶段 1：占位骨架；阶段 2 接通 routing.search + 多源（Tavily / Perplexity / Exa / DeepSeek）。
// ============================================================================

import React from 'react';
import { Search } from 'lucide-react';
import { SettingsPage } from '../SettingsLayout';

export function SearchSettings() {
  return (
    <SettingsPage
      title="搜索"
      description="选择联网搜索的提供商与优先级（Tavily / Perplexity / Exa / DeepSeek 等）。"
    >
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center">
        <Search className="h-8 w-8 text-zinc-600" />
        <div className="text-sm font-medium text-zinc-300">搜索源配置即将上线</div>
        <p className="max-w-md text-xs leading-relaxed text-zinc-500">
          搜索能力当前由内置默认源提供。多源选择与优先级（含付费源标注）正在接入，届时可在此自定义联网搜索使用哪个 provider。
        </p>
      </div>
    </SettingsPage>
  );
}

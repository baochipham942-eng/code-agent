// ============================================================================
// SearchToggleSection - 模型选择弹窗内的逐轮「联网搜索」开关
// ============================================================================
// 从 ModelSwitcher 拆出（god-file max-lines 守门）：状态（modeStore）、
// 可用性总览 IPC、置灰判据全部内聚在本组件。
// 可用判据（L0 2026-08-12 裁决）：当前模型注册表 capabilities 含 'search'
// 或有已就绪的外部搜索源；两者皆无才置灰并给原因 tooltip。

import React, { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { ModelProvider, ModelSearchCapabilityOverview } from '@shared/contract';
import { useI18n } from '../../hooks/useI18n';
import { useModeStore } from '../../stores/modeStore';
import { resolveSearchToggleAvailability } from './modelSwitcherHelpers';

export function SearchToggleSection({
  visible,
  open,
  provider,
  model,
}: {
  visible: boolean;
  open: boolean;
  provider: ModelProvider;
  model: string;
}): React.ReactElement | null {
  const { t } = useI18n();
  const text = t.settings.model.models;
  const searchEnabled = useModeStore((s) => s.searchEnabled);
  const setSearchEnabled = useModeStore((s) => s.setSearchEnabled);
  // 联网搜索可用性总览（注册表 search 标签 + 外部搜索源凭据），打开面板时从 host 拉
  const [overview, setOverview] = useState<ModelSearchCapabilityOverview | null>(null);

  useEffect(() => {
    if (!open) return;
    window.domainAPI?.invoke<ModelSearchCapabilityOverview>(
      IPC_DOMAINS.PROVIDER,
      'get_search_capabilities',
      {}
    )
      .then((res) => { if (res?.success && res.data) setOverview(res.data); })
      .catch(() => { /* 静默失败，开关按不可用置灰，不误报可联网 */ });
  }, [open]);

  if (!visible) return null;

  const available = resolveSearchToggleAvailability(overview, provider, model);

  return (
    <div
      className="px-2 pt-1.5 pb-1.5 border-b border-zinc-700/50"
      title={available ? undefined : text.searchUnavailableHint}
    >
      <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-1 px-1">
        <Globe className="w-3 h-3" />
        <span>{text.searchSectionLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-1" data-search-toggle>
        {([
          { value: 'off', label: text.searchOptionOff, selected: !searchEnabled },
          { value: 'on', label: text.searchOptionOn, selected: searchEnabled },
        ] as const).map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={!available}
            onClick={() => setSearchEnabled(option.value === 'on')}
            className={`
              inline-flex h-7 items-center justify-center rounded px-2 text-[10px] transition-colors
              ${!available
                ? 'text-zinc-600 cursor-not-allowed'
                : option.selected
                  ? 'text-zinc-300 bg-zinc-700 font-medium ring-1 ring-zinc-600/70'
                  : 'text-zinc-500 hover:bg-zinc-700/50'}
            `}
            title={available
              ? `${text.searchSectionLabel}: ${option.label}`
              : text.searchUnavailableHint}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

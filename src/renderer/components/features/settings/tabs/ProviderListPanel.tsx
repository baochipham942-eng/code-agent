// ============================================================================
// ProviderListPanel - Master-Detail 布局的左侧 Provider 列表
//
//   已可用（有 Key 或无需 Key）：完整行（名称 + Key 状态 + 模型数 + 当前徽章）
//   待添加 Key：折叠分组，精简行（点击 = 选中进入连接配置）
//   顶部：搜索 + 新增 Provider/中转站 + 运行诊断
// ============================================================================

import React, { useMemo, useState } from 'react';
import { CheckCircle, ChevronDown, ChevronRight, Plus, Search, Stethoscope } from 'lucide-react';
import type { ModelProvider } from '@shared/contract';
import { Button, Input } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';
import { describeKeylessReadiness, type ProviderManagementRow } from './ModelSettings.helpers';

interface ProviderListPanelProps {
  configuredRows: ProviderManagementRow[];
  unconfiguredRows: ProviderManagementRow[];
  /** keyless provider（local/Ollama）端点探测结果：undefined=探测中 */
  keylessReachability?: Partial<Record<string, boolean>>;
  selectedProviderId: string;
  isAddingProvider: boolean;
  onSelect: (providerId: ModelProvider) => void;
  onStartAddProvider: () => void;
  onOpenDoctor: () => void;
}

function matchRow(row: ProviderManagementRow, query: string): boolean {
  return (
    row.name.toLowerCase().includes(query) ||
    row.id.toLowerCase().includes(query) ||
    row.defaultModel.toLowerCase().includes(query)
  );
}

const KEYLESS_READINESS_TONE: Record<ReturnType<typeof describeKeylessReadiness>['state'], string> = {
  running: 'text-emerald-300',
  unavailable: 'text-amber-300',
  checking: 'text-zinc-500',
};

const ConfiguredRowStatus: React.FC<{
  row: ProviderManagementRow;
  reachable?: boolean;
}> = ({ row, reachable }) => {
  if (!row.keyless) {
    return (
      <>
        <span className="text-emerald-300">✓ Key</span> · {row.enabledModelCount}/{row.modelCount} 模型
      </>
    );
  }
  const readiness = describeKeylessReadiness(reachable);
  return (
    <>
      <span className={KEYLESS_READINESS_TONE[readiness.state]}>{readiness.label}</span>
      {readiness.state === 'running' && <> · {row.enabledModelCount}/{row.modelCount} 模型</>}
      {readiness.state === 'unavailable' && <> · 启动 Ollama 后可用</>}
    </>
  );
};

const ConfiguredRow: React.FC<{
  row: ProviderManagementRow;
  selected: boolean;
  reachable?: boolean;
  onSelect: () => void;
}> = ({ row, selected, reachable, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition ${
      selected
        ? 'border-blue-400/40 bg-blue-500/10'
        : 'border-transparent hover:bg-zinc-800/60'
    }`}
  >
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 text-xs font-semibold text-zinc-300">
      {row.name.slice(0, 1).toUpperCase()}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px] text-zinc-100">{row.name}</span>
      <span className="block truncate text-[11px] text-zinc-500">
        <ConfiguredRowStatus row={row} reachable={reachable} />
      </span>
    </span>
    {selected && (
      <span className="inline-flex shrink-0 items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
        <CheckCircle className="h-3 w-3" />
        当前
      </span>
    )}
  </button>
);

const UnconfiguredRow: React.FC<{
  row: ProviderManagementRow;
  selected: boolean;
  onSelect: () => void;
}> = ({ row, selected, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    className={`group flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition ${
      selected
        ? 'border-blue-400/40 bg-blue-500/10'
        : 'border-transparent hover:bg-zinc-800/60'
    }`}
  >
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700/70 bg-zinc-800/70 text-[10px] font-medium text-zinc-500">
      {row.name.slice(0, 1).toUpperCase()}
    </span>
    <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{row.name}</span>
    <span className={`shrink-0 text-[11px] ${selected ? 'text-blue-400' : 'text-zinc-600 group-hover:text-blue-400'}`}>
      添加 Key
    </span>
  </button>
);

export const ProviderListPanel: React.FC<ProviderListPanelProps> = ({
  configuredRows,
  unconfiguredRows,
  keylessReachability,
  selectedProviderId,
  isAddingProvider,
  onSelect,
  onStartAddProvider,
  onOpenDoctor,
}) => {
  const [search, setSearch] = useState('');
  // 选中项在待添加 Key 组里时自动展开该组
  const selectedInUnconfigured = unconfiguredRows.some((row) => row.id === selectedProviderId);
  const [unconfiguredExpanded, setUnconfiguredExpanded] = useState(selectedInUnconfigured);

  const query = search.trim().toLowerCase();
  const filteredConfigured = useMemo(
    () => (query ? configuredRows.filter((row) => matchRow(row, query)) : configuredRows),
    [configuredRows, query],
  );
  const filteredUnconfigured = useMemo(
    () => (query ? unconfiguredRows.filter((row) => matchRow(row, query)) : unconfiguredRows),
    [unconfiguredRows, query],
  );
  // 搜索时强制展开待添加 Key 组，否则按用户折叠状态 + 选中项位置
  const showUnconfigured = Boolean(query) || unconfiguredExpanded || selectedInUnconfigured;

  return (
    <aside className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
      <div className="space-y-2 border-b border-zinc-800 p-2.5">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索 Provider 或模型..."
          inputSize="sm"
          leftIcon={<Search className="h-3.5 w-3.5" />}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={isAddingProvider ? 'primary' : 'secondary'}
            onClick={onStartAddProvider}
            disabled={isWebMode()}
            leftIcon={<Plus className="h-3 w-3" />}
            className="flex-1"
          >
            新增 / 中转站
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={onOpenDoctor}
            disabled={isWebMode()}
            leftIcon={<Stethoscope className="h-3 w-3" />}
          >
            诊断
          </Button>
        </div>
      </div>

      <div className="max-h-[560px] space-y-0.5 overflow-y-auto p-2">
        <div className="px-1.5 pb-1 pt-1.5 text-[11px] text-zinc-500">
          已可用 · {filteredConfigured.length}
        </div>
        {filteredConfigured.map((row) => (
          <ConfiguredRow
            key={row.id}
            row={row}
            selected={!isAddingProvider && row.id === selectedProviderId}
            reachable={row.keyless ? keylessReachability?.[row.id] : undefined}
            onSelect={() => onSelect(row.id)}
          />
        ))}
        {filteredConfigured.length === 0 && (
          <div className="px-1.5 py-2 text-xs text-zinc-600">没有匹配的 Provider</div>
        )}

        {filteredUnconfigured.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setUnconfiguredExpanded((prev) => !prev)}
              className="flex w-full items-center gap-1 px-1.5 pb-1 pt-3 text-left text-[11px] text-zinc-500 hover:text-zinc-400"
              title="这些 Provider 还没有保存 API Key，添加后才会显示模型列表。"
            >
              {showUnconfigured ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              待添加 Key · {filteredUnconfigured.length}
            </button>
            {showUnconfigured && filteredUnconfigured.map((row) => (
              <UnconfiguredRow
                key={row.id}
                row={row}
                selected={!isAddingProvider && row.id === selectedProviderId}
                onSelect={() => onSelect(row.id)}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  );
};

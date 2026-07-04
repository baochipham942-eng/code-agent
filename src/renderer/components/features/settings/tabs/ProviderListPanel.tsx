// ============================================================================
// ProviderListPanel - Master-Detail 布局的左侧 Provider 列表
//
//   已可用（有 Key 或无需 Key）：完整行（名称 + Key 状态 + 模型数 + 当前徽章）
//   待添加 Key：折叠分组，精简行（点击 = 选中进入连接配置）
//   顶部：搜索 + 新增 Provider/中转站 + 运行诊断
// ============================================================================

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Search, Stethoscope } from 'lucide-react';
import type { ModelProvider } from '@shared/contract';
import { isProviderImageIcon } from '@shared/modelRuntime';
import { Button, Input } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';
import { useI18n } from '../../../../hooks/useI18n';
import { describeKeylessReadiness, type ProviderManagementRow } from './ModelSettings.helpers';
import { useProviderIconImageSource } from '../../../../utils/providerIconAssets';

interface ProviderListPanelProps {
  configuredRows: ProviderManagementRow[];
  unconfiguredRows: ProviderManagementRow[];
  /** keyless provider（local/Ollama）端点探测结果：undefined=探测中 */
  keylessReachability?: Partial<Record<string, boolean>>;
  selectedProviderId: string;
  /** 默认模型所属 provider：在列表里标 ★ 默认 */
  defaultProviderId?: string;
  isAddingProvider: boolean;
  onSelect: (providerId: ModelProvider) => void;
  onStartAddProvider: () => void;
  onOpenDoctor: () => void;
}

function matchRow(row: ProviderManagementRow, query: string): boolean {
  return (
    row.name.toLowerCase().includes(query) ||
    row.id.toLowerCase().includes(query) ||
    (!isProviderImageIcon(row.icon) && (row.icon?.toLowerCase().includes(query) ?? false)) ||
    row.defaultModel.toLowerCase().includes(query)
  );
}

const ProviderMark: React.FC<{ row: ProviderManagementRow; size: 'sm' | 'md' }> = ({ row, size }) => {
  const label = row.icon || row.name.slice(0, 1).toUpperCase();
  const sizeClass = size === 'md' ? 'h-7 w-7 text-xs' : 'h-5 w-5 text-[10px]';
  const imageIcon = isProviderImageIcon(row.icon);
  const imageSource = useProviderIconImageSource(row.icon);
  return (
    <span className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-zinc-700 bg-zinc-800 font-semibold text-zinc-300 ${sizeClass}`}>
      {imageIcon && imageSource ? (
        <img src={imageSource} alt="" className="h-full w-full object-cover" />
      ) : (
        label
      )}
    </span>
  );
};

const KEYLESS_READINESS_TONE: Record<ReturnType<typeof describeKeylessReadiness>['state'], string> = {
  running: 'text-emerald-300',
  unavailable: 'text-amber-300',
  checking: 'text-zinc-500',
};

const ConfiguredRowStatus: React.FC<{
  row: ProviderManagementRow;
  reachable?: boolean;
}> = ({ row, reachable }) => {
  const { t } = useI18n();
  const listText = t.settings.model.list;
  if (!row.keyless) {
    return (
      <>
        <span className="text-emerald-300">{listText.keyStatus}</span> · {row.enabledModelCount}/{row.modelCount} {listText.modelUnit}
      </>
    );
  }
  const readiness = describeKeylessReadiness(reachable, t.settings.model.helpers);
  return (
    <>
      <span className={KEYLESS_READINESS_TONE[readiness.state]}>{readiness.label}</span>
      {readiness.state === 'running' && <> · {row.enabledModelCount}/{row.modelCount} {listText.modelUnit}</>}
      {readiness.state === 'unavailable' && <> · {listText.ollamaUnavailableHint}</>}
    </>
  );
};

const ConfiguredRow: React.FC<{
  row: ProviderManagementRow;
  selected: boolean;
  isDefault?: boolean;
  reachable?: boolean;
  onSelect: () => void;
}> = ({ row, selected, isDefault, reachable, onSelect }) => {
  const { t } = useI18n();
  const listText = t.settings.model.list;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition ${
        selected
          ? 'border-blue-400/40 bg-blue-500/10'
          : 'border-transparent hover:bg-zinc-800/60'
      }`}
    >
      <ProviderMark row={row} size="md" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] text-zinc-100">{row.name}</span>
          {isDefault && (
            <span className="shrink-0 rounded border border-amber-400/40 bg-amber-400/10 px-1 text-[10px] text-amber-200">{listText.defaultBadge}</span>
          )}
        </span>
        <span className="block truncate text-[11px] text-zinc-500">
          <ConfiguredRowStatus row={row} reachable={reachable} />
        </span>
      </span>
    </button>
  );
};

const UnconfiguredRow: React.FC<{
  row: ProviderManagementRow;
  selected: boolean;
  onSelect: () => void;
}> = ({ row, selected, onSelect }) => {
  const { t } = useI18n();
  const listText = t.settings.model.list;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition ${
        selected
          ? 'border-blue-400/40 bg-blue-500/10'
          : 'border-transparent hover:bg-zinc-800/60'
      }`}
    >
      <ProviderMark row={row} size="sm" />
      <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{row.name}</span>
      <span className={`shrink-0 text-[11px] ${selected ? 'text-blue-400' : 'text-zinc-600 group-hover:text-blue-400'}`}>
        {listText.addKey}
      </span>
    </button>
  );
};

export const ProviderListPanel: React.FC<ProviderListPanelProps> = ({
  configuredRows,
  unconfiguredRows,
  keylessReachability,
  selectedProviderId,
  defaultProviderId,
  isAddingProvider,
  onSelect,
  onStartAddProvider,
  onOpenDoctor,
}) => {
  const { t } = useI18n();
  const listText = t.settings.model.list;
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
          placeholder={listText.searchPlaceholder}
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
            {listText.addProvider}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={onOpenDoctor}
            disabled={isWebMode()}
            leftIcon={<Stethoscope className="h-3 w-3" />}
          >
            {listText.doctor}
          </Button>
        </div>
      </div>

      <div className="max-h-[560px] space-y-0.5 overflow-y-auto p-2">
        <div className="px-1.5 pb-1 pt-1.5 text-[11px] text-zinc-500">
          {listText.configuredPrefix}{filteredConfigured.length}
        </div>
        {filteredConfigured.map((row) => (
          <ConfiguredRow
            key={row.id}
            row={row}
            selected={!isAddingProvider && row.id === selectedProviderId}
            isDefault={row.id === defaultProviderId}
            reachable={row.keyless ? keylessReachability?.[row.id] : undefined}
            onSelect={() => onSelect(row.id)}
          />
        ))}
        {filteredConfigured.length === 0 && (
          <div className="px-1.5 py-2 text-xs text-zinc-600">{listText.noMatch}</div>
        )}

        {filteredUnconfigured.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setUnconfiguredExpanded((prev) => !prev)}
              className="flex w-full items-center gap-1 px-1.5 pb-1 pt-3 text-left text-[11px] text-zinc-500 hover:text-zinc-400"
              title={listText.unconfiguredTooltip}
            >
              {showUnconfigured ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {listText.unconfiguredPrefix}{filteredUnconfigured.length}
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

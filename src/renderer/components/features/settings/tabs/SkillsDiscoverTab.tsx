// ============================================================================
// SkillsDiscoverTab - 发现安装
// 角色场景包 → 按场景浏览（产物分类）→ SkillsMP 搜索 → 整库安装 → 自定义仓库
// ============================================================================

import React from 'react';
import { AlertCircle, CheckCircle2, Plus, Search, ShieldCheck, X } from 'lucide-react';
import type {
  RecommendedSkillEntry,
  SkillCatalogPayload,
  SkillRepository,
  SkillRoleBundle,
} from '@shared/contract/skillRepository';
import { BUILTIN_REPO_ID } from '@shared/contract/skillRepository';
import type { SkillRegistryListItem, SkillRegistryRiskTier } from '@shared/contract/skillRegistry';
import { findRecommendedRepository, groupRecommendedSkillsByCategory, normalizeSkillCatalogPayload } from '@shared/constants/skillCatalog';
import { Button, Input } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import {
  RecommendedRepoCard,
  RecommendedSkillCard,
  RoleBundleCard,
  SkillSearchResultCard,
  type SkillsMPSearchResult,
} from './SkillsSettingsCards';

export interface SkillsDiscoverTabProps {
  /** 官方市场货架（签名 registry；离线/校验失败时为空） */
  registryItems: SkillRegistryListItem[];
  registryError: string | null;
  onInstallRegistryEntry: (item: SkillRegistryListItem) => void;
  /** 推荐目录（云端下发优先，内置兜底） */
  catalog: SkillCatalogPayload;
  recommendedRepos: SkillRepository[];
  /** 已安装仓库 ID 集合 */
  installedRepoIds: Set<string>;
  /** 本地已有的 skill 名称集合（内置 + 已安装） */
  installedSkillNames: Set<string>;
  actionLoading: string | null;
  onInstallRepo: (repo: SkillRepository) => void;
  onInstallBundle: (bundle: SkillRoleBundle) => void;
  // SkillsMP 搜索
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchResults: SkillsMPSearchResult[];
  searchTotal?: number;
  isSearching: boolean;
  searchError: string | null;
  onSearch: () => void;
  onClearSearch: () => void;
  onInstallFromSearch: (skill: SkillsMPSearchResult) => void;
  // 自定义仓库
  customUrl: string;
  onCustomUrlChange: (value: string) => void;
  onAddCustom: () => void;
}

type SkillsDiscoverLabels = typeof zh.settings.skills.discover;

/** 判断场景包是否就绪：所有非内置 skill 的来源仓库都已安装 */
export function isBundleReady(bundle: SkillRoleBundle, installedRepoIds: Set<string>): boolean {
  return bundle.skills.every(
    (skill) => skill.repoId === BUILTIN_REPO_ID || installedRepoIds.has(skill.repoId)
  );
}

/** 场景包待安装的来源仓库 ID（去重、排除内置与已安装） */
export function getBundleMissingRepoIds(
  bundle: SkillRoleBundle,
  installedRepoIds: Set<string>
): string[] {
  const missing = bundle.skills
    .map((skill) => skill.repoId)
    .filter((repoId) => repoId !== BUILTIN_REPO_ID && !installedRepoIds.has(repoId));
  return [...new Set(missing)];
}

const REGISTRY_RISK_CLASSES: Record<SkillRegistryRiskTier, string> = {
  low: 'border-zinc-700 bg-zinc-800 text-zinc-400',
  medium: 'border-amber-500/20 bg-amber-500/10 text-amber-300',
  high: 'border-red-500/20 bg-red-500/10 text-red-300',
};

const RegistryEntryCard: React.FC<{
  item: SkillRegistryListItem;
  labels: SkillsDiscoverLabels;
  onInstall: (item: SkillRegistryListItem) => void;
  isInstalling: boolean;
}> = ({ item, labels, onInstall, isInstalling }) => {
  const { entry, installed, hasUpdate } = item;
  const showAction = !installed || hasUpdate;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h5 className="truncate text-sm font-medium text-zinc-200">
              {entry.displayName || entry.name}
            </h5>
            <span className="shrink-0 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
              <ShieldCheck className="mr-0.5 inline h-3 w-3 align-[-2px]" />
              {entry.publisher}
            </span>
            {entry.risk && (
              <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${REGISTRY_RISK_CLASSES[entry.risk.tier]}`}>
                {labels.registryRiskLabels[entry.risk.tier]}
              </span>
            )}
            {hasUpdate && (
              <span className="shrink-0 rounded border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-300">
                {labels.registryHasUpdate}
              </span>
            )}
          </div>
          {entry.description && (
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">{entry.description}</p>
          )}
          <div className="mt-1 text-[11px] text-zinc-500">
            {labels.registryReviewedPrefix}
            {entry.reviewedAt}
            <span className="mx-1.5">·</span>
            <span className="font-mono">{entry.pinnedCommit.slice(0, 7)}</span>
          </div>
        </div>
        <div className="shrink-0">
          {showAction ? (
            <Button
              size="sm"
              variant={hasUpdate ? 'secondary' : 'primary'}
              disabled={isWebMode()}
              loading={isInstalling}
              onClick={() => onInstall(item)}
            >
              {hasUpdate ? labels.registryUpdate : labels.registryInstall}
            </Button>
          ) : (
            <span className="flex items-center gap-1 text-xs text-zinc-500">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              {labels.registryInstalled}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export const SkillsDiscoverTab: React.FC<SkillsDiscoverTabProps> = ({
  registryItems,
  registryError,
  onInstallRegistryEntry,
  catalog: rawCatalog,
  recommendedRepos,
  installedRepoIds,
  installedSkillNames,
  actionLoading,
  onInstallRepo,
  onInstallBundle,
  searchQuery,
  onSearchQueryChange,
  searchResults,
  searchTotal,
  isSearching,
  searchError,
  onSearch,
  onClearSearch,
  onInstallFromSearch,
  customUrl,
  onCustomUrlChange,
  onAddCustom,
}) => {
  const { t } = useI18n();
  const discoverText = t.settings.skills.discover;
  // 云端 catalog 可能半截返回；发现页是默认落地 tab，缺字段不能让整页崩
  const catalog = normalizeSkillCatalogPayload(rawCatalog);
  const categoryGroups = groupRecommendedSkillsByCategory(catalog);

  // 推荐 skill 的安装动作 = 安装其来源仓库
  const handleInstallSkill = (entry: RecommendedSkillEntry) => {
    const repo = findRecommendedRepository(entry.repoId, catalog.repositories);
    if (repo) {
      onInstallRepo(repo);
    }
  };

  return (
    <div className="space-y-6">
      {/* 官方市场（签名 registry） */}
      <div className="space-y-3">
        <div>
          <h4 className="text-sm font-medium text-zinc-200">{discoverText.registryTitle}</h4>
          <p className="text-xs text-zinc-500 mt-0.5">{discoverText.registryDescription}</p>
        </div>
        {registryItems.length > 0 ? (
          <div className="space-y-2">
            {registryItems.map((item) => (
              <RegistryEntryCard
                key={item.entry.name}
                item={item}
                labels={discoverText}
                onInstall={onInstallRegistryEntry}
                isInstalling={actionLoading === `registry-${item.entry.name}`}
              />
            ))}
          </div>
        ) : (
          registryError && (
            <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 p-3 text-xs text-zinc-500">
              <AlertCircle className="h-3.5 w-3.5" />
              {discoverText.registryEmpty}
            </div>
          )
        )}
      </div>

      {/* 角色场景包 */}
      <div className="space-y-3">
        <div>
          <h4 className="text-sm font-medium text-zinc-200">{discoverText.roleBundlesTitle}</h4>
          <p className="text-xs text-zinc-500 mt-0.5">{discoverText.roleBundlesDescription}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {catalog.bundles.map((bundle) => (
            <RoleBundleCard
              key={bundle.id}
              bundle={bundle}
              isReady={isBundleReady(bundle, installedRepoIds)}
              onInstall={onInstallBundle}
              isInstalling={actionLoading === `bundle-${bundle.id}`}
            />
          ))}
        </div>
      </div>

      {/* 按场景浏览 */}
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium text-zinc-200">{discoverText.browseTitle}</h4>
          <p className="text-xs text-zinc-500 mt-0.5">{discoverText.browseDescription}</p>
        </div>
        {categoryGroups.map(({ category, skills }) => (
          <div key={category.id} className="space-y-2">
            <div className="flex items-baseline gap-2">
              <h5 className="text-xs font-medium text-zinc-300">{category.label}</h5>
              <span className="text-[10px] text-zinc-500">{category.description}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {skills.map((entry) => (
                <RecommendedSkillCard
                  key={entry.name}
                  entry={entry}
                  isInstalled={
                    installedSkillNames.has(entry.name) || installedRepoIds.has(entry.repoId)
                  }
                  sourceRepoName={findRecommendedRepository(entry.repoId, catalog.repositories)?.name}
                  onInstall={handleInstallSkill}
                  isInstalling={actionLoading === entry.repoId}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* SkillsMP 搜索 */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-zinc-200">{discoverText.searchTitle}</h4>
        <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === 'Enter' && !isSearching) {
                    onSearch();
                  }
                }}
                placeholder={discoverText.searchPlaceholder}
                inputSize="sm"
                disabled={isSearching}
                className="pr-8"
              />
              {searchQuery && !isSearching && (
                <button
                  type="button"
                  onClick={onClearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-400"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Button
              size="sm"
              variant="primary"
              disabled={isWebMode() || !searchQuery.trim()}
              onClick={onSearch}
              loading={isSearching}
              leftIcon={!isSearching ? <Search className="h-3 w-3" /> : undefined}
            >
              {discoverText.searchButton}
            </Button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {discoverText.searchSourcePrefix}{' '}
            <a
              href="https://skillsmp.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300"
            >
              SkillsMP
            </a>
            {' '}{discoverText.searchSourceSuffix}
          </p>

          {/* 搜索结果 */}
          {searchResults.length > 0 && (
            <div className="mt-4 max-h-80 space-y-2 overflow-y-auto">
              <div className="mb-2 text-xs text-zinc-400">
                {searchTotal
                  ? `${discoverText.resultCountPrefix}${searchTotal.toLocaleString()}${discoverText.resultCountMiddle}${searchResults.length}${discoverText.resultCountSuffix}`
                  : `${discoverText.foundCountPrefix}${searchResults.length}${discoverText.foundCountSuffix}`}
              </div>
              {searchResults.map((skill) => (
                <SkillSearchResultCard
                  key={skill.id}
                  skill={skill}
                  onInstall={onInstallFromSearch}
                  isInstalling={actionLoading === `skillsmp-${skill.id}`}
                />
              ))}
            </div>
          )}

          {/* 搜索错误 */}
          {searchError && (
            <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
              <AlertCircle className="h-3 w-3" />
              {searchError}
            </div>
          )}
        </div>
      </div>

      {/* 整库安装 */}
      {recommendedRepos.length > 0 && (
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-medium text-zinc-200">{discoverText.reposTitle}</h4>
            <p className="text-xs text-zinc-500 mt-0.5">{discoverText.reposDescription}</p>
          </div>
          {recommendedRepos.map((repo) => (
            <RecommendedRepoCard
              key={repo.id}
              repo={repo}
              onInstall={onInstallRepo}
              isInstalling={actionLoading === repo.id}
            />
          ))}
        </div>
      )}

      {/* 自定义仓库 */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-zinc-200">{discoverText.customTitle}</h4>
        <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-4">
          <div className="space-y-2">
            <Input
              value={customUrl}
              onChange={(event) => onCustomUrlChange(event.target.value)}
              placeholder="https://github.com/user/my-skills"
              inputSize="sm"
              disabled={actionLoading === 'custom'}
            />
            <p className="text-xs text-zinc-500">
              {discoverText.customDescription}
            </p>
          </div>
          <div className="mt-3">
            <Button
              size="sm"
              variant="secondary"
              disabled={isWebMode() || !customUrl.trim()}
              onClick={onAddCustom}
              loading={actionLoading === 'custom'}
              leftIcon={actionLoading !== 'custom' ? <Plus className="h-3 w-3" /> : undefined}
            >
              {discoverText.addRepo}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

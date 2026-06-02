// ============================================================================
// SkillsDiscoverTab - 发现安装
// 角色场景包 → 按场景浏览（产物分类）→ SkillsMP 搜索 → 整库安装 → 自定义仓库
// ============================================================================

import React from 'react';
import { AlertCircle, Plus, Search, X } from 'lucide-react';
import type {
  RecommendedSkillEntry,
  SkillRepository,
  SkillRoleBundle,
} from '@shared/contract/skillRepository';
import { BUILTIN_REPO_ID } from '@shared/contract/skillRepository';
import {
  SKILL_ROLE_BUNDLES,
  findRecommendedRepository,
  groupRecommendedSkillsByCategory,
} from '@shared/constants/skillCatalog';
import { Button, Input } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';
import {
  RecommendedRepoCard,
  RecommendedSkillCard,
  RoleBundleCard,
  SkillSearchResultCard,
  type SkillsMPSearchResult,
} from './SkillsSettingsCards';

export interface SkillsDiscoverTabProps {
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

export const SkillsDiscoverTab: React.FC<SkillsDiscoverTabProps> = ({
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
  const categoryGroups = groupRecommendedSkillsByCategory();

  // 推荐 skill 的安装动作 = 安装其来源仓库
  const handleInstallSkill = (entry: RecommendedSkillEntry) => {
    const repo = findRecommendedRepository(entry.repoId);
    if (repo) {
      onInstallRepo(repo);
    }
  };

  return (
    <div className="space-y-6">
      {/* 角色场景包 */}
      <div className="space-y-3">
        <div>
          <h4 className="text-sm font-medium text-zinc-200">角色场景包</h4>
          <p className="text-xs text-zinc-500 mt-0.5">按你的角色一键配齐常用 Skill</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {SKILL_ROLE_BUNDLES.map((bundle) => (
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
          <h4 className="text-sm font-medium text-zinc-200">按场景浏览</h4>
          <p className="text-xs text-zinc-500 mt-0.5">社区与官方的热门 Skill，按要做的事分类</p>
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
                  sourceRepoName={findRecommendedRepository(entry.repoId)?.name}
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
        <h4 className="text-sm font-medium text-zinc-200">搜索社区 Skill</h4>
        <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isSearching) {
                    onSearch();
                  }
                }}
                placeholder="输入需求，如：代码审查、Git 提交..."
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
              搜索
            </Button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            从{' '}
            <a
              href="https://skillsmp.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300"
            >
              SkillsMP
            </a>
            {' '}搜索 9 万+ 社区 Skills
          </p>

          {/* 搜索结果 */}
          {searchResults.length > 0 && (
            <div className="mt-4 max-h-80 space-y-2 overflow-y-auto">
              <div className="mb-2 text-xs text-zinc-400">
                {searchTotal
                  ? `共 ${searchTotal.toLocaleString()} 个结果，显示前 ${searchResults.length} 个：`
                  : `找到 ${searchResults.length} 个结果：`}
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
            <h4 className="text-sm font-medium text-zinc-200">整库安装</h4>
            <p className="text-xs text-zinc-500 mt-0.5">一次安装一个 Skill 仓库的全部内容</p>
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
        <h4 className="text-sm font-medium text-zinc-200">添加自定义 Skill 库</h4>
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
              输入 GitHub 仓库 URL，仓库根目录需包含 skill 目录结构
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
              添加仓库
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

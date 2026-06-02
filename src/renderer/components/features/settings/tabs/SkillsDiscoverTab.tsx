// ============================================================================
// SkillsDiscoverTab - 发现安装（推荐仓库 + SkillsMP 搜索 + 自定义仓库）
// ============================================================================

import React from 'react';
import { AlertCircle, Plus, Search, X } from 'lucide-react';
import type { SkillRepository } from '@shared/contract/skillRepository';
import { Button, Input } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';
import {
  RecommendedRepoCard,
  SkillSearchResultCard,
  type SkillsMPSearchResult,
} from './SkillsSettingsCards';

export interface SkillsDiscoverTabProps {
  recommendedRepos: SkillRepository[];
  actionLoading: string | null;
  onInstallRepo: (repo: SkillRepository) => void;
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

export const SkillsDiscoverTab: React.FC<SkillsDiscoverTabProps> = ({
  recommendedRepos,
  actionLoading,
  onInstallRepo,
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
}) => (
  <div className="space-y-6">
    {/* 推荐仓库 */}
    {recommendedRepos.length > 0 && (
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-zinc-200">推荐安装</h4>
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

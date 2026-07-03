import React from 'react';
import {
  Check,
  ExternalLink,
  Package,
  Plus,
  Star,
} from 'lucide-react';
import type {
  RecommendedSkillEntry,
  SkillRepository,
  SkillRoleBundle,
} from '@shared/contract/skillRepository';
import { BUILTIN_REPO_ID } from '@shared/contract/skillRepository';
import { Button } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';
import { useI18n } from '../../../../hooks/useI18n';

export interface SkillsMPSearchResult {
  id: string;
  name: string;
  description: string;
  author: string;
  githubUrl: string;
  skillUrl: string;
  stars: number;
  updatedAt: number;
}

interface RecommendedRepoCardProps {
  repo: SkillRepository;
  onInstall: (repo: SkillRepository) => void;
  isInstalling: boolean;
}

export const RecommendedRepoCard: React.FC<RecommendedRepoCardProps> = ({
  repo,
  onInstall,
  isInstalling,
}) => {
  const { t } = useI18n();
  const cardsText = t.settings.skills.cards;

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Package className="w-5 h-5 text-blue-400 shrink-0" />
        <div>
          <h4 className="text-sm font-medium text-zinc-200">{repo.name}</h4>
          {repo.description && (
            <p className="text-xs text-zinc-400 mt-0.5">{repo.description}</p>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="primary"
        onClick={() => onInstall(repo)}
        loading={isInstalling}
        leftIcon={!isInstalling ? <Plus className="w-3 h-3" /> : undefined}
      >
        {cardsText.install}
      </Button>
    </div>
  );
};

// ----------------------------------------------------------------------------
// 推荐 Skill 卡片（skill 粒度，按产物分类展示）
// ----------------------------------------------------------------------------

interface RecommendedSkillCardProps {
  entry: RecommendedSkillEntry;
  /** skill 已在本地（内置或已随仓库安装） */
  isInstalled: boolean;
  /** 来源仓库显示名（builtin 时为空） */
  sourceRepoName?: string;
  onInstall: (entry: RecommendedSkillEntry) => void;
  isInstalling: boolean;
}

export const RecommendedSkillCard: React.FC<RecommendedSkillCardProps> = ({
  entry,
  isInstalled,
  sourceRepoName,
  onInstall,
  isInstalling,
}) => {
  const { t } = useI18n();
  const cardsText = t.settings.skills.cards;
  const isBuiltin = entry.repoId === BUILTIN_REPO_ID;

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-3 hover:border-zinc-600 transition-colors flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h5 className="text-sm font-medium text-zinc-200 truncate">{entry.displayName}</h5>
            {entry.badge && (
              <span className="shrink-0 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-400">
                {entry.badge}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{entry.description}</p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 mt-auto">
        <span className="text-[10px] text-zinc-500 truncate">
          {isBuiltin ? cardsText.builtinSkill : sourceRepoName ? `${cardsText.sourcePrefix}${sourceRepoName}` : ''}
        </span>
        {isBuiltin || isInstalled ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-400">
            <Check className="w-3 h-3" />
            {isBuiltin ? cardsText.builtinInstalled : cardsText.installed}
          </span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onInstall(entry)}
            loading={isInstalling}
            disabled={isWebMode()}
            leftIcon={!isInstalling ? <Plus className="w-3 h-3" /> : undefined}
          >
            {cardsText.install}
          </Button>
        )}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// 角色场景包卡片
// ----------------------------------------------------------------------------

interface RoleBundleCardProps {
  bundle: SkillRoleBundle;
  /** 包内所有非内置 skill 的来源仓库是否都已安装 */
  isReady: boolean;
  onInstall: (bundle: SkillRoleBundle) => void;
  isInstalling: boolean;
}

export const RoleBundleCard: React.FC<RoleBundleCardProps> = ({
  bundle,
  isReady,
  onInstall,
  isInstalling,
}) => {
  const { t } = useI18n();
  const cardsText = t.settings.skills.cards;

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-4 hover:border-zinc-600 transition-colors flex flex-col gap-3">
      <div>
        <h5 className="text-sm font-medium text-zinc-200">{bundle.name}</h5>
        <p className="text-xs text-zinc-400 mt-1">{bundle.description}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {bundle.skills.map((skill) => (
          <span
            key={skill.name}
            className="rounded bg-zinc-700/60 px-1.5 py-0.5 text-[10px] text-zinc-300"
          >
            {skill.displayName}
          </span>
        ))}
      </div>
      <div className="flex items-center justify-end mt-auto">
        {isReady ? (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <Check className="w-3 h-3" />
            {cardsText.ready}
          </span>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => onInstall(bundle)}
            loading={isInstalling}
            disabled={isWebMode()}
            leftIcon={!isInstalling ? <Plus className="w-3 h-3" /> : undefined}
          >
            {cardsText.installAll}
          </Button>
        )}
      </div>
    </div>
  );
};

interface SkillSearchResultCardProps {
  skill: SkillsMPSearchResult;
  onInstall: (skill: SkillsMPSearchResult) => void;
  isInstalling: boolean;
}

export const SkillSearchResultCard: React.FC<SkillSearchResultCardProps> = ({
  skill,
  onInstall,
  isInstalling,
}) => {
  const { t } = useI18n();
  const cardsText = t.settings.skills.cards;
  const formatStars = (stars: number) => {
    if (stars >= 1000) {
      return `${(stars / 1000).toFixed(1)}k`;
    }
    return stars.toString();
  };

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 p-3 hover:border-zinc-600 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <a
              href={skill.skillUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-zinc-200 truncate hover:text-blue-400"
            >
              {skill.name}
            </a>
            <div className="flex items-center gap-1 text-xs text-amber-400 shrink-0">
              <Star className="w-3 h-3 fill-current" />
              <span>{formatStars(skill.stars)}</span>
            </div>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5 truncate">
            by {skill.author}
          </p>
          {skill.description && (
            <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{skill.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={skill.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<ExternalLink className="w-3 h-3" />}
            >
              {cardsText.view}
            </Button>
          </a>
          <Button
            size="sm"
            variant="primary"
            onClick={() => onInstall(skill)}
            loading={isInstalling}
            disabled={isWebMode()}
            leftIcon={!isInstalling ? <Plus className="w-3 h-3" /> : undefined}
          >
            {cardsText.install}
          </Button>
        </div>
      </div>
    </div>
  );
};

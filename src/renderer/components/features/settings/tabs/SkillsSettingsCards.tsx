import React from 'react';
import {
  ExternalLink,
  Package,
  Plus,
  Star,
} from 'lucide-react';
import type { SkillRepository } from '@shared/contract/skillRepository';
import { Button } from '../../../primitives';
import { isWebMode } from '../../../../utils/platform';

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
}) => (
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
      安装
    </Button>
  </div>
);

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
              查看
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
            安装
          </Button>
        </div>
      </div>
    </div>
  );
};

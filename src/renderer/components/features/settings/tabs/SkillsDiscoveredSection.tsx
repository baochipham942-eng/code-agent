import React, { useMemo } from 'react';
import { Package } from 'lucide-react';
import type { ParsedSkill, SkillSource } from '@shared/contract/agentSkill';
import { SettingsSection } from '../SettingsLayout';

export interface DiscoveredSkillSummary {
  totalSkills: number;
  bySource: Record<SkillSource, number>;
}

const SKILL_SOURCE_LABELS: Record<SkillSource, string> = {
  builtin: 'Builtin',
  cloud: 'Cloud',
  library: 'Library',
  plugin: 'Plugin',
  project: 'Project',
  user: 'User',
};

export function buildDiscoveredSkillSummary(skills: ParsedSkill[]): DiscoveredSkillSummary {
  const bySource: Record<SkillSource, number> = {
    builtin: 0,
    cloud: 0,
    library: 0,
    plugin: 0,
    project: 0,
    user: 0,
  };

  for (const skill of skills) {
    bySource[skill.source] += 1;
  }

  return {
    totalSkills: skills.length,
    bySource,
  };
}

interface SkillsDiscoveredSectionProps {
  skills: ParsedSkill[];
}

export const SkillsDiscoveredSection: React.FC<SkillsDiscoveredSectionProps> = ({ skills }) => {
  const summary = useMemo(() => buildDiscoveredSkillSummary(skills), [skills]);
  const sortedSkills = useMemo(
    () => [...skills].sort((a, b) => {
      const sourceOrder = a.source.localeCompare(b.source);
      if (sourceOrder !== 0) return sourceOrder;
      return a.name.localeCompare(b.name);
    }),
    [skills],
  );

  return (
    <SettingsSection
      title="已发现 Skills"
      description="扫描本机和当前项目的 Skill 元数据；会话使用时再加载正文。"
    >
      <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60">
        <div className="grid grid-cols-2 gap-px border-b border-zinc-700/60 bg-zinc-800/80 lg:grid-cols-4">
          {[
            ['总数', String(summary.totalSkills), '可挂载或可调用'],
            ['User', String(summary.bySource.user), '用户目录'],
            ['Project', String(summary.bySource.project), '项目目录'],
            ['Library', String(summary.bySource.library), '仓库目录'],
          ].map(([label, value, caption]) => (
            <div key={label} className="bg-zinc-900/80 px-3 py-3">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-zinc-500">{label}</div>
              <div className="mt-1 truncate text-lg font-semibold text-zinc-100">{value}</div>
              <div className="mt-0.5 truncate text-[11px] text-zinc-500">{caption}</div>
            </div>
          ))}
        </div>

        {sortedSkills.length === 0 ? (
          <div className="p-8 text-center">
            <Package className="mx-auto mb-2 h-8 w-8 text-zinc-500" />
            <p className="text-sm text-zinc-400">还没有发现 Skill</p>
          </div>
        ) : (
          <div className="max-h-[360px] overflow-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="sticky top-0 border-b border-zinc-800 bg-zinc-950 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Skill</th>
                  <th className="px-3 py-2 font-medium">来源</th>
                  <th className="px-3 py-2 font-medium">调用</th>
                  <th className="px-3 py-2 font-medium">路径</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {sortedSkills.map((skill) => (
                  <tr key={`${skill.source}:${skill.basePath || skill.name}`} className="bg-zinc-950/30 hover:bg-zinc-800/50">
                    <td className="px-3 py-3 align-top">
                      <div className="font-medium text-zinc-200">{skill.name}</div>
                      <div className="mt-1 line-clamp-2 max-w-[420px] text-zinc-500">{skill.description}</div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="inline-flex rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-300">
                        {SKILL_SOURCE_LABELS[skill.source]}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className={skill.disableModelInvocation ? 'text-zinc-500' : 'text-emerald-300'}>
                        {skill.disableModelInvocation ? '手动' : '可用'}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="max-w-[360px] truncate font-mono text-[11px] text-zinc-600" title={skill.basePath || skill.source}>
                        {skill.basePath || skill.source}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SettingsSection>
  );
};

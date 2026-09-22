import type { CompanionLibrary } from '../../../../../src/shared/contract/companionLibrary';
import { UNSORTED_PROJECT_ID } from '../../../../../src/shared/contract/project';

/**
 * 项目选择器主层的行模型（fix5-③，2026-09-15 build 36 反馈⑦：项目 sheet 看不懂）。
 * 目标形态照设计稿 design.html 的 screen('project')：每行「项目名 + 副标题（最近使用 · N 个
 * 会话）」，同名项目用路径消歧。抽纯函数是为了让消歧截断与副标题判定可单测（照
 * drawerGesture / connectionCopy 的先例）。
 */
export interface ProjectRowModel {
  id: string;
  /** 行首主文案：项目名；与其他项目同名且带路径时追加「 · 父目录一级」。 */
  label: string;
  /** 行内副标题：「最近使用 · N 个会话」或「N 个会话」。 */
  subtitle: string;
  canCreate: boolean;
}

/**
 * 工作目录 → 消歧标签：取父目录一级（`…/ai/workspace` → `…/ai`），macOS 用户目录折叠成
 * `~`（`/Users/neo/Downloads/ai` → `~/Downloads/ai`），超过 maxChars 从中间截断（两头
 * 保留目录名最有辨识度的部分）。
 */
function workspaceParentLabel(path: string, maxChars = 24): string {
  const trimmed = path.replace(/\/+$/, '');
  const segments = trimmed.split('/').filter(Boolean);
  segments.pop();   // 工作目录本身一级不出现，出现的是它的父目录
  let label = segments.length ? `/${segments.join('/')}` : '/';
  if (label.startsWith('/Users/') && segments.length > 2) {
    label = `~/${segments.slice(2).join('/')}`;
  }
  if (label.length <= maxChars) return label;
  const keep = maxChars - 1;   // 留一个位置给省略号
  return `${label.slice(0, Math.ceil(keep / 2))}…${label.slice(-Math.floor(keep / 2))}`;
}

/**
 * 项目的显示名：与其他项目同名且带工作目录时带路径消歧后缀（前进页标题与主层行同文，
 * 点进行页标题就是刚才点的那一行）。
 */
export function projectDisplayName(project: CompanionLibrary['projects'][number], all: CompanionLibrary['projects']): string {
  const ambiguous = all.filter(other => other.name === project.name).length > 1
    && typeof project.workspacePath === 'string' && project.workspacePath;
  return ambiguous ? `${project.name} · ${workspaceParentLabel(project.workspacePath!)}` : project.name;
}

/**
 * 主层全部行。subtitle 的「最近使用」给**最近有过会话的那个项目**（会话按 updated_at 倒序
 * 来自电脑，第一条就是全局最近）；N 为已加载到手机的项目内会话数。
 */
export function projectRowModels(
  projects: CompanionLibrary['projects'],
  sessions: CompanionLibrary['sessions'],
  copy: { recent: (count: number) => string; count: (count: number) => string },
): ProjectRowModel[] {
  const recentProjectId = sessions[0]?.projectId ?? null;
  return projects.map(project => {
    const count = sessions.filter(session => session.projectId === project.id).length;
    return {
      id: project.id,
      label: projectDisplayName(project, projects),
      subtitle: project.id === recentProjectId ? copy.recent(count) : copy.count(count),
      canCreate: project.canCreate,
    };
  });
}

/**
 * 新任务默认落在哪个项目（N-MOBILE-DEFAULT-PROJECT，design.md §11，爸 09-17 拍板）：
 * 手选过的 > 最近一次（手机或电脑）用过的 > 未分类 > 列表里第一个能建的；候选必须此刻能建，都建不了回 null。
 * 最后一档是兜底：手机可能只被授权了某几个项目（没有未分类），那些项目下又还没有会话（PR#1913 ai-review）。
 * 「最近用过」= updatedAt 最新那条会话的项目，库里的会话是两端共用的，所以电脑上刚用过的也算。
 */
export function defaultProjectId(library: CompanionLibrary, picked: string | undefined): string | null {
  const creatable = (id: string | null | undefined) => library.projects.find(project => project.id === id && project.canCreate)?.id ?? null;
  const recent = library.sessions.reduce<CompanionLibrary['sessions'][number] | null>((top, session) => !top || session.updatedAt > top.updatedAt ? session : top, null);
  return creatable(picked) ?? creatable(recent?.projectId) ?? creatable(UNSORTED_PROJECT_ID)
    ?? library.projects.find(project => project.canCreate)?.id ?? null;
}

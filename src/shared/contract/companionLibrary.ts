import { z } from 'zod';
import { COMPANION_LIMITS as L } from '../constants/companion';

/** Project grants are explicit desktop choices; existing session grants stay narrow. */
export const projectGrant = (id: string) => `project:${id}`;
/** Invite scope for every current project. Empty library must not call invite. */
export function projectScope(projects: readonly { id: string }[]): string[] {
  return projects.map(project => projectGrant(project.id));
}
/** True when stored grants cover every current project. Missing any project is a narrow/legacy device. */
export function hasFullProjectScope(scope: readonly string[], projects: readonly { id: string }[]): boolean {
  return projects.length > 0 && projects.every(project => scope.includes(projectGrant(project.id)));
}
export const companionReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library'), offset: z.number().int().nonnegative().safe().default(0) }).strict(),
  z.object({ kind: z.literal('history'), sessionId: z.string().min(1).max(L.idLength),
    offset: z.number().int().nonnegative().safe().default(0) }).strict(),
  z.object({ kind: z.literal('artifacts'), sessionId: z.string().min(1).max(L.idLength) }).strict(),
]);
export type CompanionRead = z.infer<typeof companionReadSchema>;
// File-local: only CompanionLibrary below refers to it.
interface CompanionSessionSummary {
  id: string; title: string; projectId: string | null; updatedAt: number; archived: boolean;
  provider: string; model: string;
}
export interface CompanionLibrary {
  nextOffset: number | null;
  /**
   * workspacePath = 电脑上这个项目的工作目录（fix5-③，2026-09-15 build 36 反馈⑦：4 个同名
   * workspace 无消歧）。可缺省——旧 Host 不带它，手机侧消歧标签跟着降级为不显示。
   */
  projects: { id: string; name: string; canCreate: boolean; workspacePath?: string | null }[];
  sessions: CompanionSessionSummary[];
  /** isDefault = 电脑自己新建会话会用的那个模型；手机的下拉默认必须跟着它，不是跟着列表顺序。 */
  models: { provider: string; model: string; label: string; providerLabel: string; isDefault?: true }[];
}
export interface CompanionHistory {
  sessionId: string;
  messages: { id: string; role: string; content: string; timestamp: number; truncated?: boolean }[];
  nextOffset: number | null;
}

export interface CompanionArtifact {
  artifactId: string;
  version: number;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  origin: 'upload' | 'result';
}

export interface CompanionArtifacts {
  sessionId: string;
  artifacts: CompanionArtifact[];
}

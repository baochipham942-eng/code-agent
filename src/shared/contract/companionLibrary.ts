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
  /** 下一次执行真正会用的模型（会话 override 否则电脑默认），不是建会话时的快照。 */
  provider: string; model: string;
}
export interface CompanionLibrary {
  nextOffset: number | null;
  /**
   * workspacePath = 电脑上这个项目的工作目录（fix5-③，2026-09-15 build 36 反馈⑦：4 个同名
   * workspace 无消歧）。可缺省——旧 Host 不带它，手机侧消歧标签跟着降级为不显示。
   */
  projects: {
    id: string; name: string; workspacePath?: string | null;
    /** 此刻能不能在这个项目里新建会话（授权 + 宿主前提都满足）。旧 Host 只按授权给。 */
    canCreate: boolean;
    /** 建不了的原因，缺省 = 能建或旧 Host 没说。not_granted = 这台设备没有项目授权；no_workspace = 电脑上没设工作目录。 */
    createBlocked?: 'not_granted' | 'no_workspace';
  }[];
  sessions: CompanionSessionSummary[];
  /**
   * isDefault = 电脑一处算好的默认（电脑默认且未失败 ＞ 同供应商第一个未失败 ＞ 列表第一个未失败 ＞ 全失败取第一个）。
   * recentlyFailed = 最近调用失败；failureKind 区分模型级停用 / 供应商密钥 / 网络 / 余额额度，旧 Host 可能只带 recentlyFailed。
   */
  models: {
    provider: string; model: string; label: string; providerLabel: string;
    isDefault?: true; recentlyFailed?: true; failureKind?: 'model' | 'auth' | 'network' | 'quota';
  }[];
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

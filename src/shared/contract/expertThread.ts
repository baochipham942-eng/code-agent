export const EXPERT_THREAD_METADATA_KEY = 'expertThread';

export interface PersistedExpertThread {
  roleId: string;
  setAt: number;
}

export function readPersistedExpertThread(
  metadata: Record<string, unknown> | undefined,
): PersistedExpertThread | null {
  const raw = metadata?.[EXPERT_THREAD_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (typeof marker.roleId !== 'string' || marker.roleId.length === 0) return null;
  if (typeof marker.setAt !== 'number') return null;
  return { roleId: marker.roleId, setAt: marker.setAt };
}

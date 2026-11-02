export const EXECUTION_ENVIRONMENT_METADATA_KEY = 'executionEnvironment';

/** ADR-081/087：会话账本不换边，云端只是回合执行地。这个粘性标记只记录「本会话跑过云」。 */
export interface PersistedExecutionEnvironment {
  kind: 'cloud';
  environmentId: string;
  setAt: number;
}

export function readPersistedExecutionEnvironment(
  metadata: Record<string, unknown> | undefined,
): PersistedExecutionEnvironment | null {
  const raw = metadata?.[EXECUTION_ENVIRONMENT_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (marker.kind !== 'cloud') return null;
  if (typeof marker.environmentId !== 'string' || marker.environmentId.length === 0) return null;
  if (typeof marker.setAt !== 'number') return null;
  return { kind: 'cloud', environmentId: marker.environmentId, setAt: marker.setAt };
}

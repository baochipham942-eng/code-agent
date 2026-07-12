import type { RunEnvelope } from '../../shared/contract/durableRun';

export const DURABLE_RUN_ROLLOUT_ENV = 'CODE_AGENT_DURABLE_RUN_MODE';

export type DurableRunRolloutMode = 'legacy' | 'dual_write' | 'durable_preferred';

export interface DurableRunRolloutPolicy {
  mode: DurableRunRolloutMode;
  configuredValue: string | null;
  valid: boolean;
  durableActivation: boolean;
  durableReadPreference: boolean;
  diagnostic?: string;
}

export interface DurableRunFactReader {
  getLatestBySession(sessionId: string): Promise<RunEnvelope | null>;
}

export type DurableRunReadResult<TLegacy> =
  | { source: 'durable'; value: RunEnvelope }
  | { source: 'legacy'; value: TLegacy };

const VALID_MODES = new Set<DurableRunRolloutMode>([
  'legacy',
  'dual_write',
  'durable_preferred',
]);

/**
 * The rollout decision is resolved once by application bootstrap. An invalid
 * value disables both Durable activation and Durable reads so a process can
 * never start in a half-enabled state.
 */
export function resolveDurableRunRollout(
  env: NodeJS.ProcessEnv = process.env,
): DurableRunRolloutPolicy {
  const configuredValue = env[DURABLE_RUN_ROLLOUT_ENV]?.trim() || null;
  const requested = configuredValue ?? 'durable_preferred';
  if (!VALID_MODES.has(requested as DurableRunRolloutMode)) {
    return {
      mode: 'legacy',
      configuredValue,
      valid: false,
      durableActivation: false,
      durableReadPreference: false,
      diagnostic: `${DURABLE_RUN_ROLLOUT_ENV}=${JSON.stringify(requested)} is invalid; `
        + 'Durable Run activation and read preference are disabled',
    };
  }

  const mode = requested as DurableRunRolloutMode;
  return {
    mode,
    configuredValue,
    valid: true,
    durableActivation: mode !== 'legacy',
    durableReadPreference: mode === 'durable_preferred',
  };
}

/**
 * Existing Durable rows are authoritative in durable_preferred. Repository
 * failures are propagated; only a proven absence of a Durable row may fall
 * back to pre-migration legacy data.
 */
export async function readWithDurablePreference<TLegacy>(input: {
  policy: DurableRunRolloutPolicy;
  reader: DurableRunFactReader | null;
  sessionId: string;
  readLegacy: () => TLegacy | Promise<TLegacy>;
}): Promise<DurableRunReadResult<TLegacy>> {
  if (!input.policy.durableReadPreference) {
    return { source: 'legacy', value: await input.readLegacy() };
  }
  if (!input.reader) {
    throw new Error('Durable Run read preference is enabled but the repository is unavailable');
  }
  const durable = await input.reader.getLatestBySession(input.sessionId);
  if (durable) return { source: 'durable', value: durable };
  return { source: 'legacy', value: await input.readLegacy() };
}

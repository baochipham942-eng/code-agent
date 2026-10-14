import { getFeatureFlagService } from '../cloud/featureFlagService';

/**
 * The one production read for the K1D feature flag. Environment override is
 * intentionally explicit and is useful for keyed acceptance only.
 */
export function isCrossSessionDelegationEnabled(): boolean {
  return process.env.CODE_AGENT_CROSS_SESSION_DELEGATION === '1'
    || getFeatureFlagService().isEnabled('crossSessionDelegation');
}

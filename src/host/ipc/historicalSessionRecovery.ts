import type { HistoricalSessionRecoveryRequest, HistoricalSessionRecoveryResult } from '../../shared/contract/historicalSessionRecovery';
import { getAuthService } from '../services/auth/authService';
import { getDatabase } from '../services/core/databaseService';
import { HistoricalSessionRecoveryRepository } from '../services/core/repositories/HistoricalSessionRecoveryRepository';

export function recoverHistoricalSession(payload: HistoricalSessionRecoveryRequest): HistoricalSessionRecoveryResult {
  const auth = getAuthService();
  const actor = auth.hasVerifiedSession() ? auth.getCurrentUser()?.id : null;
  const db = getDatabase().getDb();
  if (!actor || !db) return { status: 'rejected', code: !actor ? 'AUTH_REQUIRED' : 'DATABASE_UNAVAILABLE',
    historyReadable: false, sourceContinuable: false, targetContinuable: false };
  return new HistoricalSessionRecoveryRepository(db).recover(actor, payload);
}

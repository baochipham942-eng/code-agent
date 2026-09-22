import type { InferenceOptions } from '../../../model/types';
import { getBudgetService, BudgetAlertLevel } from '../../../services';
import type { ContextAssemblyCtx } from './shared';
import { logger } from './shared';

export function maxModeBudgetHeadroomOk(ctx: ContextAssemblyCtx): boolean {
  try {
    const { alertLevel } = getBudgetService(ctx.runtime.budgetScope).checkBudget();
    const ok = alertLevel !== BudgetAlertLevel.WARNING && alertLevel !== BudgetAlertLevel.BLOCKED;
    if (!ok) logger.warn(`[MaxMode] budget alertLevel=${alertLevel}; skipping best-of-N fanout for this step`);
    return ok;
  } catch {
    return true;
  }
}

export function cacheOptionsForMaxModeCall(options: InferenceOptions, kind?: 'candidate' | 'judge'): InferenceOptions {
  if (kind !== 'judge') return options;
  return { ...options, cacheRetention: 'none', cacheScopeId: 'judge' };
}

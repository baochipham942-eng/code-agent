export const STEPFUN_PLAN_BASE_URL = 'https://api.stepfun.com/step_plan/v1';

export function resolveStepfunBaseUrl(
  env: { STEPFUN_BASE_URL?: string } = process.env,
): string {
  const configured = env.STEPFUN_BASE_URL?.trim().replace(/\/+$/, '');
  return configured || STEPFUN_PLAN_BASE_URL;
}

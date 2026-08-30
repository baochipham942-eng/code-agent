import { useI18n } from '@renderer/hooks/useI18n';
import { evalCenterEn, evalCenterZh } from './evaluationCenter';

export function useEvaluationI18n() {
  const core = useI18n();
  const evaluation = core.language === 'zh' ? evalCenterZh : evalCenterEn;

  return {
    ...core,
    t: {
      ...core.t,
      ...evaluation,
    },
  };
}

// 聊天过程详略：级别只在这里映射成渲染行为，组件只读这三个字段。
import { useAppStore, type DisclosureLevel } from '../stores/appStore';

const WORK_DETAIL_POLICY: Record<DisclosureLevel, {
  foldThreshold: number;
  toolGroupDefaultExpanded: boolean;
  showThinkingDigest: boolean;
}> = {
  // standard 与改动前硬编码一致：满 5 个节点才折叠，工具组默认收起，思考横幅保留。
  'simple': { foldThreshold: 2, toolGroupDefaultExpanded: false, showThinkingDigest: false },
  'standard': { foldThreshold: 5, toolGroupDefaultExpanded: false, showThinkingDigest: true },
  'advanced': { foldThreshold: Infinity, toolGroupDefaultExpanded: false, showThinkingDigest: true },
  'expert': { foldThreshold: Infinity, toolGroupDefaultExpanded: true, showThinkingDigest: true },
};

export function useWorkDetailPolicy() {
  const disclosureLevel = useAppStore((state) => state.disclosureLevel);
  return WORK_DETAIL_POLICY[disclosureLevel] ?? WORK_DETAIL_POLICY.standard;
}

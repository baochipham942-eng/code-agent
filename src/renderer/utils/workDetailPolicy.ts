// 聊天过程详略：级别只在这里映射成渲染行为，组件只读这三个字段。
import { useAppStore, type DisclosureLevel } from '../stores/appStore';

const WORK_DETAIL_POLICY: Record<DisclosureLevel, {
  foldThreshold: number;
  toolGroupDefaultExpanded: boolean;
  showThinkingDigest: boolean;
  keepLastTurnOpen: boolean;
}> = {
  // standard 与改动前硬编码一致：满 5 个节点才折叠，工具组默认收起，思考横幅保留，末轮保持展开。
  // simple 的 keepLastTurnOpen=false（2026-10-17 拍板 B）：末轮完成后同样折成
  // 「用时」一行 + 结论；流式期间照常展开，收尾那一下自动收回（TurnCard 落地）。
  'simple': { foldThreshold: 2, toolGroupDefaultExpanded: false, showThinkingDigest: false, keepLastTurnOpen: false },
  'standard': { foldThreshold: 5, toolGroupDefaultExpanded: false, showThinkingDigest: true, keepLastTurnOpen: true },
  'advanced': { foldThreshold: Infinity, toolGroupDefaultExpanded: false, showThinkingDigest: true, keepLastTurnOpen: true },
  'expert': { foldThreshold: Infinity, toolGroupDefaultExpanded: true, showThinkingDigest: true, keepLastTurnOpen: true },
};

export function useWorkDetailPolicy() {
  const disclosureLevel = useAppStore((state) => state.disclosureLevel);
  return WORK_DETAIL_POLICY[disclosureLevel] ?? WORK_DETAIL_POLICY.standard;
}

import { Sparkles, X } from 'lucide-react';
import { useNeoWorkCardStore } from '../../../../stores/neoWorkCardStore';

/** @neo 续接 chip：composer 态标记「这条消息续接哪个 topic」，可移除（ADR-035 D1）。 */
export function NeoContinuationChip() {
  const target = useNeoWorkCardStore((state) => state.continuationTarget);
  const setTarget = useNeoWorkCardStore((state) => state.setContinuationTarget);
  if (!target) return null;
  return (
    <div
      data-testid="neo-continuation-chip"
      className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400"
    >
      <Sparkles className="h-3 w-3" />
      <span className="max-w-[220px] truncate">续接 · {target.title}</span>
      <button
        type="button"
        aria-label="移除续接"
        className="rounded-full p-0.5 hover:bg-emerald-500/20"
        onClick={() => setTarget(null)}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

import { useState, useCallback, memo, useMemo, lazy, Suspense } from 'react';
import { BarChart3, Copy, Check } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { UI } from '@shared/constants';
import { parseChartSpecSource } from '@shared/chartSpec';
export { isChartSpecSource } from '@shared/chartSpec';

// recharts(~444KB)按需动态加载,只在真正渲染 chart 代码块时才下载,移出首屏关键路径。
const LazyChartRenderer = lazy(() => import('./ChartRenderer'));

// 加载中的骨架:固定高度与 ChartRenderer 内 ResponsiveContainer 一致,避免图表就绪后布局跳变。
function ChartSkeleton() {
  return <div className="h-[300px] animate-pulse rounded-lg bg-zinc-800/40" />;
}

export const ChartBlock = memo(function ChartBlock({ spec: rawSpec }: { spec: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();

  const parsedSpec = useMemo(() => parseChartSpecSource(rawSpec), [rawSpec]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(rawSpec);
    setCopied(true);
    setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
  }, [rawSpec]);

  if (!parsedSpec) {
    return null;
  }

  return (
    <div className="my-3 rounded-xl bg-zinc-900 overflow-hidden border border-zinc-700 shadow-lg">
      <div className="flex items-center justify-between gap-3 px-4 py-2 bg-zinc-800 border-b border-zinc-700">
        <div className="flex min-w-0 items-center gap-2">
          <BarChart3 className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
          <span className="min-w-0 truncate text-xs font-medium text-emerald-400">
            {parsedSpec.title || t.generativeUI.chart}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="flex shrink-0 items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-green-400" />
              <span className="text-green-400">{t.generativeUI.copied}</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>JSON</span>
            </>
          )}
        </button>
      </div>
      <div className="p-4 select-none">
        <Suspense fallback={<ChartSkeleton />}>
          <LazyChartRenderer spec={parsedSpec} />
        </Suspense>
      </div>
    </div>
  );
});

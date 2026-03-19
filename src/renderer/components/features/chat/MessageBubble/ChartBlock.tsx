import { useState, useCallback, memo, useMemo } from 'react';
import { BarChart3, Copy, Check } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import {
  ResponsiveContainer,
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  PieChart, Pie, Cell,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { UI } from '@shared/constants';

interface SeriesItem {
  key: string;
  name?: string;
  color?: string;
}

interface ChartSpec {
  type: 'bar' | 'line' | 'area' | 'pie' | 'radar' | 'scatter';
  title?: string;
  xKey?: string;
  series?: SeriesItem[];
  data: Record<string, unknown>[];
}

const DEFAULT_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316',
];

const darkTooltipStyle = {
  contentStyle: {
    backgroundColor: '#27272a',
    border: '1px solid #3f3f46',
    borderRadius: '0.5rem',
    color: '#e4e4e7',
    fontSize: '0.75rem',
  },
  itemStyle: { color: '#a1a1aa' },
  cursor: { fill: 'rgba(255, 255, 255, 0.06)' },
};

const axisStyle = { fontSize: 11, fill: '#a1a1aa' };

function parseSpec(raw: string): ChartSpec | null {
  try {
    const spec = JSON.parse(raw);
    if (!spec || !spec.type || !Array.isArray(spec.data)) return null;
    return spec as ChartSpec;
  } catch {
    return null;
  }
}

const ChartRenderer = memo(function ChartRenderer({ spec }: { spec: ChartSpec }) {
  const { type, xKey = 'name', series = [], data } = spec;

  if (type === 'pie') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={100}
            label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
          >
            {data.map((entry, i) => (
              <Cell key={i} fill={(entry as Record<string, string>).color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip {...darkTooltipStyle} />
          <Legend wrapperStyle={{ fontSize: '0.75rem', color: '#a1a1aa' }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (type === 'radar') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <RadarChart data={data}>
          <PolarGrid stroke="#3f3f46" />
          <PolarAngleAxis dataKey={xKey} tick={axisStyle} />
          <PolarRadiusAxis tick={axisStyle} />
          {series.map((s, i) => (
            <Radar
              key={s.key}
              name={s.name || s.key}
              dataKey={s.key}
              stroke={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              fill={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              fillOpacity={0.3}
            />
          ))}
          <Tooltip {...darkTooltipStyle} />
          <Legend wrapperStyle={{ fontSize: '0.75rem', color: '#a1a1aa' }} />
        </RadarChart>
      </ResponsiveContainer>
    );
  }

  if (type === 'scatter') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
          <XAxis dataKey={xKey} tick={axisStyle} stroke="#3f3f46" />
          <YAxis tick={axisStyle} stroke="#3f3f46" />
          {series.map((s, i) => (
            <Scatter
              key={s.key}
              name={s.name || s.key}
              data={data}
              fill={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
            />
          ))}
          <Tooltip {...darkTooltipStyle} />
          <Legend wrapperStyle={{ fontSize: '0.75rem', color: '#a1a1aa' }} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  const ChartComponent = type === 'line' ? LineChart : type === 'area' ? AreaChart : BarChart;
  const SeriesComponent = type === 'line' ? Line : type === 'area' ? Area : Bar;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ChartComponent data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
        <XAxis dataKey={xKey} tick={axisStyle} stroke="#3f3f46" />
        <YAxis tick={axisStyle} stroke="#3f3f46" />
        <Tooltip {...darkTooltipStyle} />
        <Legend wrapperStyle={{ fontSize: '0.75rem', color: '#a1a1aa' }} />
        {series.map((s, i) => {
          const color = s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
          const commonProps = {
            key: s.key,
            dataKey: s.key,
            name: s.name || s.key,
            ...(type === 'area' ? { fill: color, fillOpacity: 0.3, stroke: color } : { fill: color, stroke: color }),
          };
          return <SeriesComponent {...commonProps} />;
        })}
      </ChartComponent>
    </ResponsiveContainer>
  );
});

export const ChartBlock = memo(function ChartBlock({ spec: rawSpec }: { spec: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();

  const parsedSpec = useMemo(() => parseSpec(rawSpec), [rawSpec]);

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
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800 border-b border-zinc-700">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-xs font-medium text-emerald-400">
            {parsedSpec.title || t.generativeUI.chart}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all text-xs"
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
        <ChartRenderer spec={parsedSpec} />
      </div>
    </div>
  );
});

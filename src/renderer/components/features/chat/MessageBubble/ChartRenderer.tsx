// ChartRenderer — 唯一静态 import recharts 的地方。ChartBlock.tsx 只保留外壳（标题栏/复制
// 按钮），实际图表渲染改为 React.lazy(() => import('./ChartRenderer')) 懒加载。

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
import type { ChartSpec } from '@shared/chartSpec';

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

const ChartRenderer = ({ spec }: { spec: ChartSpec }) => {
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

  if (series.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-lg border border-dashed border-zinc-700 bg-zinc-950/40 px-4 text-center text-xs leading-relaxed text-zinc-500">
        No numeric data series found.
      </div>
    );
  }

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
};

export default ChartRenderer;

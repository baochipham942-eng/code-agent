// ============================================================================
// RadarChart - 雷达图组件（SVG 实现）
// ============================================================================

import React from 'react';
import type { EvaluationMetric } from '../../../../shared/types/evaluation';
import { DIMENSION_NAMES } from '../../../../shared/types/evaluation';

interface RadarChartProps {
  metrics: EvaluationMetric[];
  size?: number;
}

export function RadarChart({ metrics, size = 200 }: RadarChartProps) {
  const center = size / 2;
  const radius = size * 0.4;
  const levels = 5;

  // 计算多边形顶点
  const getPoint = (index: number, value: number): { x: number; y: number } => {
    const angle = (Math.PI * 2 * index) / metrics.length - Math.PI / 2;
    const r = (value / 100) * radius;
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
    };
  };

  // 生成网格多边形
  const gridPolygons = Array.from({ length: levels }, (_, levelIndex) => {
    const levelValue = ((levelIndex + 1) / levels) * 100;
    const points = metrics
      .map((_, i) => {
        const p = getPoint(i, levelValue);
        return `${p.x},${p.y}`;
      })
      .join(' ');
    return points;
  });

  // 生成数据多边形
  const dataPoints = metrics
    .map((m, i) => {
      const p = getPoint(i, m.score);
      return `${p.x},${p.y}`;
    })
    .join(' ');

  // 生成轴线
  const axisLines = metrics.map((_, i) => {
    const p = getPoint(i, 100);
    return { x1: center, y1: center, x2: p.x, y2: p.y };
  });

  // 生成标签位置
  const labels = metrics.map((m, i) => {
    const p = getPoint(i, 120);
    return {
      x: p.x,
      y: p.y,
      text: DIMENSION_NAMES[m.dimension],
      score: m.score,
    };
  });

  return (
    <svg width={size} height={size} className="overflow-visible">
      {/* 网格 */}
      {gridPolygons.map((points, i) => (
        <polygon
          key={i}
          points={points}
          fill="none"
          stroke="rgb(63, 63, 70)"
          strokeWidth="1"
          opacity={0.5}
        />
      ))}

      {/* 轴线 */}
      {axisLines.map((line, i) => (
        <line
          key={i}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke="rgb(63, 63, 70)"
          strokeWidth="1"
          opacity={0.5}
        />
      ))}

      {/* 数据区域 */}
      <polygon
        points={dataPoints}
        fill="rgba(59, 130, 246, 0.3)"
        stroke="rgb(59, 130, 246)"
        strokeWidth="2"
      />

      {/* 数据点 */}
      {metrics.map((m, i) => {
        const p = getPoint(i, m.score);
        return (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r="4"
            fill="rgb(59, 130, 246)"
            stroke="white"
            strokeWidth="1"
          />
        );
      })}

      {/* 标签 */}
      {labels.map((label, i) => (
        <g key={i}>
          <text
            x={label.x}
            y={label.y}
            textAnchor="middle"
            dominantBaseline="middle"
            className="text-[10px] fill-gray-400"
          >
            {label.text}
          </text>
          <text
            x={label.x}
            y={label.y + 12}
            textAnchor="middle"
            dominantBaseline="middle"
            className="text-[9px] fill-gray-500"
          >
            {label.score}
          </text>
        </g>
      ))}
    </svg>
  );
}

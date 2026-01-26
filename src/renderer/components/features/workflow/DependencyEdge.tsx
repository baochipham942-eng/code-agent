// ============================================================================
// DependencyEdge - 自定义 React Flow 依赖边
// Session 5: React Flow 可视化
// ============================================================================

import React, { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Position,
} from '@xyflow/react';
import type { DependencyEdgeData } from '../../../../shared/types/dagVisualization';

// Re-export for use by other files
export type { DependencyEdgeData };

interface DependencyEdgeProps {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  data?: DependencyEdgeData;
  selected?: boolean;
  markerEnd?: string;
}

/**
 * 依赖边组件
 */
export const DependencyEdge = memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
}: DependencyEdgeProps) => {
  const isCriticalPath = data?.isCriticalPath;
  const isActive = data?.isActive;
  const dependencyType = data?.dependencyType;
  const label = data?.label;

  // 计算路径
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // 根据状态确定样式
  const getEdgeStyle = (): React.CSSProperties => {
    if (isActive) {
      return {
        stroke: '#3B82F6',
        strokeWidth: 3,
        filter: 'drop-shadow(0 0 4px rgba(59, 130, 246, 0.5))',
      };
    }
    if (isCriticalPath) {
      return {
        stroke: '#F59E0B',
        strokeWidth: 2.5,
        strokeDasharray: '8 4',
      };
    }
    if (selected) {
      return {
        stroke: '#60A5FA',
        strokeWidth: 2,
      };
    }
    return {
      stroke: '#4B5563',
      strokeWidth: 1.5,
    };
  };

  const edgeStyle = getEdgeStyle();

  // 依赖类型的样式
  const getDependencyTypeStyle = (): React.CSSProperties => {
    switch (dependencyType) {
      case 'data':
        return { strokeDasharray: undefined };
      case 'control':
        return { strokeDasharray: '5 5' };
      case 'checkpoint':
        return { strokeDasharray: '2 2' };
      default:
        return {};
    }
  };

  const finalStyle = { ...edgeStyle, ...getDependencyTypeStyle() };

  return (
    <>
      {/* 动画边（活跃时） */}
      {isActive && (
        <BaseEdge
          id={`${id}-glow`}
          path={edgePath}
          style={{
            stroke: '#3B82F6',
            strokeWidth: 6,
            strokeOpacity: 0.3,
            filter: 'blur(3px)',
          }}
        />
      )}

      {/* 主边 */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={finalStyle}
        className={isActive ? 'animated-edge' : ''}
      />

      {/* 流动动画粒子（活跃时） */}
      {isActive && (
        <circle r="4" fill="#3B82F6" className="edge-particle">
          <animateMotion
            dur="1.5s"
            repeatCount="indefinite"
            path={edgePath}
          />
        </circle>
      )}

      {/* 标签 */}
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`
              absolute px-2 py-0.5 text-[10px] font-medium rounded
              bg-gray-800 text-gray-300 border border-gray-600
              pointer-events-all nodrag nopan
              ${selected ? 'ring-1 ring-blue-400' : ''}
            `}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

DependencyEdge.displayName = 'DependencyEdge';

export default DependencyEdge;

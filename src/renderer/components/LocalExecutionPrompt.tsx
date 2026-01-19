// ============================================================================
// LocalExecutionPrompt - 本地执行确认组件
// 当任务被路由到本地执行时，显示确认对话框
// ============================================================================

import React, { useState } from 'react';
import { UI } from '@shared/constants';
import {
  Monitor,
  Cloud,
  GitBranch,
  AlertTriangle,
  Shield,
  Clock,
  Zap,
  X,
  Check,
  Info,
} from 'lucide-react';
import type {
  TaskRoutingDecision,
  TaskExecutionLocation,
  CloudAgentType,
} from '@shared/types/cloud';

// ============================================================================
// 类型定义
// ============================================================================

interface LocalExecutionPromptProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (location: TaskExecutionLocation) => void;
  routingDecision: TaskRoutingDecision;
  taskTitle: string;
  taskType: CloudAgentType;
  prompt?: string;
}

// ============================================================================
// 辅助组件
// ============================================================================

const LocationOption: React.FC<{
  location: TaskExecutionLocation;
  title: string;
  description: string;
  reasons: string[];
  isRecommended?: boolean;
  isSelected: boolean;
  onSelect: () => void;
}> = ({
  location,
  title,
  description,
  reasons,
  isRecommended,
  isSelected,
  onSelect,
}) => {
  const icons = {
    local: Monitor,
    cloud: Cloud,
    hybrid: GitBranch,
  };

  const colors = {
    local: 'emerald',
    cloud: 'sky',
    hybrid: 'purple',
  };

  const Icon = icons[location];
  const color = colors[location];

  return (
    <button
      onClick={onSelect}
      className={`
        w-full p-4 rounded-lg border-2 text-left transition-all
        ${isSelected
          ? `border-${color}-500 bg-${color}-500/10`
          : 'border-zinc-700 bg-zinc-800/50 hover:border-zinc-600'
        }
      `}
    >
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg bg-${color}-500/20`}>
          <Icon className={`w-5 h-5 text-${color}-400`} />
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-zinc-200">{title}</span>
            {isRecommended && (
              <span className="text-xs px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded">
                推荐
              </span>
            )}
          </div>

          <p className="text-sm text-zinc-400 mb-2">{description}</p>

          {reasons.length > 0 && (
            <ul className="space-y-1">
              {reasons.map((reason, i) => (
                <li key={i} className="text-xs text-zinc-500 flex items-center gap-1">
                  <span className={`w-1 h-1 rounded-full bg-${color}-400`} />
                  {reason}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center
          ${isSelected ? `border-${color}-500 bg-${color}-500` : 'border-zinc-600'}
        `}>
          {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
        </div>
      </div>
    </button>
  );
};

const ReasonBadge: React.FC<{ reason: string }> = ({ reason }) => {
  // 根据原因类型显示不同图标
  let icon = <Info className="w-3 h-3" />;
  let color = 'zinc';

  if (reason.includes('敏感') || reason.includes('安全') || reason.includes('sensitive')) {
    icon = <Shield className="w-3 h-3" />;
    color = 'red';
  } else if (reason.includes('文件') || reason.includes('file') || reason.includes('local')) {
    icon = <Monitor className="w-3 h-3" />;
    color = 'emerald';
  } else if (reason.includes('快') || reason.includes('fast') || reason.includes('响应')) {
    icon = <Zap className="w-3 h-3" />;
    color = 'yellow';
  } else if (reason.includes('长') || reason.includes('long') || reason.includes('时间')) {
    icon = <Clock className="w-3 h-3" />;
    color = 'blue';
  }

  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-${color}-500/10 text-${color}-400`}>
      {icon}
      {reason}
    </span>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const LocalExecutionPrompt: React.FC<LocalExecutionPromptProps> = ({
  isOpen,
  onClose,
  onConfirm,
  routingDecision,
  taskTitle,
  taskType,
  prompt,
}) => {
  const [selectedLocation, setSelectedLocation] = useState<TaskExecutionLocation>(
    routingDecision.recommendedLocation
  );

  if (!isOpen) return null;

  // 生成选项描述
  const locationDescriptions = {
    local: {
      title: '本地执行',
      description: '在您的设备上运行，可以访问本地文件和命令',
      reasons: [
        '完全访问本地文件系统',
        '可以执行系统命令',
        '数据不离开本地',
        '响应速度快',
      ],
    },
    cloud: {
      title: '云端执行',
      description: '在云端服务器运行，不占用本地资源',
      reasons: [
        '不占用本地计算资源',
        '可以并行执行多个任务',
        '长时间任务不会阻塞',
        '跨设备同步结果',
      ],
    },
    hybrid: {
      title: '混合执行',
      description: '智能拆分任务，本地和云端协同处理',
      reasons: [
        '自动优化任务分配',
        '平衡速度和资源',
        '敏感部分本地处理',
        '计算密集部分云端处理',
      ],
    },
  };

  const handleConfirm = () => {
    onConfirm(selectedLocation);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* 对话框 */}
      <div className="relative w-full max-w-2xl mx-4 bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl">
        {/* 头部 */}
        <div className="flex items-start justify-between p-4 border-b border-zinc-800">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">
              选择执行位置
            </h2>
            <p className="text-sm text-zinc-400 mt-1">
              {taskTitle}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-200 rounded"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 路由决策信息 */}
        <div className="p-4 border-b border-zinc-800 bg-zinc-800/30">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-yellow-500/10">
              <AlertTriangle className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <p className="text-sm text-zinc-300 mb-2">
                {routingDecision.reason}
              </p>
              <div className="flex flex-wrap gap-2">
                <span className="text-xs text-zinc-500">
                  置信度: {Math.round(routingDecision.confidence * 100)}%
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 执行位置选项 */}
        <div className="p-4 space-y-3">
          {(['local', 'cloud', 'hybrid'] as TaskExecutionLocation[]).map((location) => (
            <LocationOption
              key={location}
              location={location}
              title={locationDescriptions[location].title}
              description={locationDescriptions[location].description}
              reasons={locationDescriptions[location].reasons}
              isRecommended={location === routingDecision.recommendedLocation}
              isSelected={selectedLocation === location}
              onSelect={() => setSelectedLocation(location)}
            />
          ))}
        </div>

        {/* Prompt 预览（可折叠） */}
        {prompt && (
          <details className="mx-4 mb-4 p-3 bg-zinc-800/50 rounded-lg">
            <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">
              查看任务内容
            </summary>
            <pre className="mt-2 text-xs text-zinc-400 whitespace-pre-wrap max-h-32 overflow-y-auto">
              {prompt.slice(0, UI.PREVIEW_TEXT_MAX_LENGTH)}
              {prompt.length > UI.PREVIEW_TEXT_MAX_LENGTH && '...'}
            </pre>
          </details>
        )}

        {/* 底部按钮 */}
        <div className="flex justify-end gap-3 p-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
          >
            确认执行
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 简化版本地执行提示
// ============================================================================

interface SimpleLocalPromptProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirmLocal: () => void;
  onConfirmCloud: () => void;
  reason: string;
}

export const SimpleLocalPrompt: React.FC<SimpleLocalPromptProps> = ({
  isOpen,
  onClose,
  onConfirmLocal,
  onConfirmCloud,
  reason,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-md mx-4 bg-zinc-900 rounded-xl border border-zinc-700 shadow-2xl p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 rounded-lg bg-emerald-500/10">
            <Monitor className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <h3 className="font-medium text-zinc-100">建议本地执行</h3>
            <p className="text-sm text-zinc-400 mt-1">{reason}</p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onConfirmCloud}
            className="flex-1 px-4 py-2 text-sm text-zinc-400 border border-zinc-700 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <Cloud className="w-4 h-4 inline mr-1" />
            仍在云端执行
          </button>
          <button
            onClick={onConfirmLocal}
            className="flex-1 px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
          >
            <Monitor className="w-4 h-4 inline mr-1" />
            本地执行
          </button>
        </div>
      </div>
    </div>
  );
};

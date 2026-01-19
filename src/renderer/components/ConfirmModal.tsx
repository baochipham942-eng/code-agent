// ============================================================================
// ConfirmModal - Reusable confirmation dialog
// ============================================================================

import React from 'react';
import { AlertTriangle, Info, Shield, Key } from 'lucide-react';
import { Modal, ModalHeader, ModalFooter, Button } from './primitives';

export type ConfirmModalType = 'warning' | 'danger' | 'info' | 'security';

interface Props {
  title: string;
  message: string | React.ReactNode;
  type?: ConfirmModalType;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** If true, show only confirm button (no cancel) */
  singleAction?: boolean;
}

const typeConfig: Record<ConfirmModalType, {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  confirmBg: string;
}> = {
  warning: {
    icon: <AlertTriangle className="w-6 h-6" />,
    iconBg: 'bg-amber-500/10',
    iconColor: 'text-amber-400',
    confirmBg: 'bg-amber-600 hover:bg-amber-500',
  },
  danger: {
    icon: <AlertTriangle className="w-6 h-6" />,
    iconBg: 'bg-red-500/10',
    iconColor: 'text-red-400',
    confirmBg: 'bg-red-600 hover:bg-red-500',
  },
  info: {
    icon: <Info className="w-6 h-6" />,
    iconBg: 'bg-blue-500/10',
    iconColor: 'text-blue-400',
    confirmBg: 'bg-blue-600 hover:bg-blue-500',
  },
  security: {
    icon: <Shield className="w-6 h-6" />,
    iconBg: 'bg-indigo-500/10',
    iconColor: 'text-indigo-400',
    confirmBg: 'bg-indigo-600 hover:bg-indigo-500',
  },
};

export const ConfirmModal: React.FC<Props> = ({
  title,
  message,
  type = 'warning',
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
  singleAction = false,
}) => {
  const config = typeConfig[type];

  return (
    <Modal
      isOpen={true}
      onClose={singleAction ? undefined : onCancel}
      title={title}
      size="md"
      closeOnBackdropClick={!singleAction}
      closeOnEsc={!singleAction}
      showCloseButton={!singleAction}
      headerIcon={
        <div className={`p-2 rounded-lg ${config.iconBg} ${config.iconColor}`}>
          {config.icon}
        </div>
      }
      footer={
        <ModalFooter
          cancelText={cancelText}
          confirmText={confirmText}
          onCancel={singleAction ? undefined : onCancel}
          onConfirm={onConfirm}
          confirmColorClass={config.confirmBg}
          hideCancel={singleAction}
        />
      }
    >
      {typeof message === 'string' ? (
        <p className="text-sm text-zinc-300 leading-relaxed">{message}</p>
      ) : (
        message
      )}
    </Modal>
  );
};

// ============================================================================
// ApiKeySetupModal - First-run API key setup prompt
// ============================================================================

interface ApiKeySetupModalProps {
  onSetup: () => void;
  onSkip: () => void;
}

export const ApiKeySetupModal: React.FC<ApiKeySetupModalProps> = ({
  onSetup,
  onSkip,
}) => {
  return (
    <Modal
      isOpen={true}
      size="md"
      closeOnBackdropClick={false}
      closeOnEsc={false}
      showCloseButton={false}
      headerIcon={
        <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
          <Key className="w-6 h-6" />
        </div>
      }
      title="配置 API Key"
      footer={
        <ModalFooter
          cancelText="稍后配置"
          confirmText="前往设置"
          onCancel={onSkip}
          onConfirm={onSetup}
          confirmColorClass="bg-indigo-600 hover:bg-indigo-500"
        />
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-zinc-300 leading-relaxed">
          欢迎使用 Code Agent！为了开始使用 AI 助手功能，您需要先配置 API Key。
        </p>

        <div className="bg-zinc-800/50 rounded-lg p-4 space-y-2">
          <h4 className="text-sm font-medium text-zinc-100">支持的模型提供商：</h4>
          <ul className="text-xs text-zinc-400 space-y-1">
            <li>• <span className="text-zinc-300">DeepSeek</span> - 高性价比，推荐用于日常开发</li>
            <li>• <span className="text-zinc-300">OpenRouter</span> - 支持 Gemini、Claude、GPT 等多种模型</li>
            <li>• <span className="text-zinc-300">Anthropic Claude</span> - 高质量代码生成</li>
            <li>• <span className="text-zinc-300">OpenAI</span> - GPT-4o 系列</li>
          </ul>
        </div>

        <p className="text-xs text-zinc-500">
          您可以随时在设置中更改 API Key 配置。
        </p>
      </div>
    </Modal>
  );
};

// ============================================================================
// ToolCreateConfirmModal - Confirm before creating dynamic tool
// ============================================================================

export interface ToolCreateRequest {
  id: string;
  name: string;
  description: string;
  type: string;
  code?: string;
  script?: string;
}

interface ToolCreateConfirmModalProps {
  request: ToolCreateRequest;
  onAllow: () => void;
  onDeny: () => void;
}

export const ToolCreateConfirmModal: React.FC<ToolCreateConfirmModalProps> = ({
  request,
  onAllow,
  onDeny,
}) => {
  const isDangerous = request.type === 'bash_script';

  return (
    <Modal
      isOpen={true}
      onClose={onDeny}
      size="lg"
      headerBgClass={isDangerous ? 'bg-red-500/10' : 'bg-indigo-500/10'}
      header={
        <ModalHeader
          icon={isDangerous ? <AlertTriangle className="w-6 h-6" /> : <Shield className="w-6 h-6" />}
          iconBgClass={isDangerous ? 'bg-red-500/20' : 'bg-indigo-500/20'}
          iconColorClass={isDangerous ? 'text-red-400' : 'text-indigo-400'}
          title="创建动态工具"
          subtitle="AI 请求创建以下工具"
          onClose={onDeny}
        />
      }
      footer={
        <ModalFooter>
          <Button
            onClick={onDeny}
            variant="ghost"
          >
            拒绝
          </Button>
          <Button
            onClick={onAllow}
            variant={isDangerous ? 'danger' : 'primary'}
            leftIcon={<Shield className="w-4 h-4" />}
            className={isDangerous ? '' : '!bg-indigo-600 hover:!bg-indigo-500'}
          >
            允许创建
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        {/* Warning for bash_script */}
        {isDangerous && (
          <div className="flex items-start gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="text-sm text-red-300">
              此工具类型为 <code className="px-1 bg-red-500/20 rounded">bash_script</code>，可以执行系统命令。请仔细确认后再允许。
            </div>
          </div>
        )}

        {/* Tool Info */}
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <span className="text-xs text-zinc-500 w-16 shrink-0">名称:</span>
            <span className="text-sm text-zinc-100 font-mono">{request.name}</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs text-zinc-500 w-16 shrink-0">类型:</span>
            <span className={`text-sm font-mono px-2 py-0.5 rounded ${
              isDangerous ? 'bg-red-500/20 text-red-300' : 'bg-zinc-800 text-zinc-300'
            }`}>
              {request.type}
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs text-zinc-500 w-16 shrink-0">描述:</span>
            <span className="text-sm text-zinc-300">{request.description}</span>
          </div>
        </div>

        {/* Code Preview */}
        {(request.code || request.script) && (
          <div className="space-y-1">
            <span className="text-xs text-zinc-500">代码预览:</span>
            <pre className={`text-xs p-3 rounded-lg border overflow-x-auto max-h-40 ${
              isDangerous
                ? 'bg-red-500/10 border-red-500/20 text-red-300'
                : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-300'
            }`}>
              {(request.code || request.script || '').slice(0, 500)}
              {(request.code || request.script || '').length > 500 && '...'}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
};

// ============================================================================
// DevModeConfirmModal - Confirm before enabling devModeAutoApprove
// ============================================================================

interface DevModeConfirmModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export const DevModeConfirmModal: React.FC<DevModeConfirmModalProps> = ({
  onConfirm,
  onCancel,
}) => {
  return (
    <Modal
      isOpen={true}
      onClose={onCancel}
      size="md"
      headerBgClass="bg-amber-500/10"
      headerIcon={
        <div className="p-2 rounded-lg bg-amber-500/20 text-amber-400">
          <AlertTriangle className="w-6 h-6" />
        </div>
      }
      title="安全警告"
      footer={
        <ModalFooter
          cancelText="取消"
          confirmText="我了解风险，确认开启"
          onCancel={onCancel}
          onConfirm={onConfirm}
          confirmColorClass="bg-amber-600 hover:bg-amber-500"
        />
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-zinc-300 leading-relaxed">
          您即将开启<span className="font-medium text-amber-400">「自动授权所有权限」</span>模式。
        </p>

        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-2">
          <h4 className="text-sm font-medium text-amber-400">开启后将会：</h4>
          <ul className="text-xs text-amber-300/80 space-y-1.5">
            <li>• 跳过所有危险操作的确认弹窗</li>
            <li>• 自动授权 AI 创建和执行工具</li>
            <li>• 允许 AI 执行文件写入、命令运行等操作</li>
          </ul>
        </div>

        <div className="bg-zinc-800/50 rounded-lg p-3">
          <p className="text-xs text-zinc-400">
            <span className="text-zinc-300 font-medium">建议：</span>仅在受控的开发环境中使用此功能。
            生产环境或处理敏感项目时请保持关闭。
          </p>
        </div>
      </div>
    </Modal>
  );
};

// ============================================================================
// ConfirmModal - Reusable confirmation dialog
// ============================================================================

import React from 'react';
import { AlertTriangle, Shield } from 'lucide-react';
import { Modal, ModalHeader, ModalFooter, Button } from './primitives';
import { UI } from '@shared/constants';

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
            <span className="text-sm text-zinc-200 font-mono">{request.name}</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs text-zinc-500 w-16 shrink-0">类型:</span>
            <span className={`text-sm font-mono px-2 py-0.5 rounded ${
              isDangerous ? 'bg-red-500/20 text-red-300' : 'bg-zinc-700 text-zinc-400'
            }`}>
              {request.type}
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs text-zinc-500 w-16 shrink-0">描述:</span>
            <span className="text-sm text-zinc-400">{request.description}</span>
          </div>
        </div>

        {/* Code Preview */}
        {(request.code || request.script) && (
          <div className="space-y-1">
            <span className="text-xs text-zinc-500">代码预览:</span>
            <pre className={`text-xs p-3 rounded-lg border overflow-x-auto max-h-40 ${
              isDangerous
                ? 'bg-red-500/10 border-red-500/20 text-red-300'
                : 'bg-zinc-800 border-zinc-700 text-zinc-400'
            }`}>
              {(request.code || request.script || '').slice(0, UI.PREVIEW_TEXT_MAX_LENGTH)}
              {(request.code || request.script || '').length > UI.PREVIEW_TEXT_MAX_LENGTH && '...'}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
};

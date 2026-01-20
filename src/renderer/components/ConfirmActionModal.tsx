// ============================================================================
// ConfirmActionModal - Display confirmation dialogs from confirm_action tool
// ============================================================================

import React from 'react';
import { AlertTriangle, Info, AlertCircle } from 'lucide-react';
import type { ConfirmActionRequest } from '@shared/ipc';
import { IPC_CHANNELS } from '@shared/ipc';
import { Modal, ModalFooter } from './primitives/Modal';
import { createLogger } from '../utils/logger';

const logger = createLogger('ConfirmActionModal');

interface Props {
  request: ConfirmActionRequest;
  onClose: () => void;
}

const typeConfig = {
  danger: {
    icon: <AlertTriangle className="w-6 h-6" />,
    iconBg: 'bg-red-500/10',
    iconColor: 'text-red-400',
    confirmBg: 'bg-red-600 hover:bg-red-500',
    headerBg: 'bg-red-500/10',
  },
  warning: {
    icon: <AlertCircle className="w-6 h-6" />,
    iconBg: 'bg-amber-500/10',
    iconColor: 'text-amber-400',
    confirmBg: 'bg-amber-600 hover:bg-amber-500',
    headerBg: 'bg-amber-500/10',
  },
  info: {
    icon: <Info className="w-6 h-6" />,
    iconBg: 'bg-blue-500/10',
    iconColor: 'text-blue-400',
    confirmBg: 'bg-blue-600 hover:bg-blue-500',
    headerBg: 'bg-blue-500/10',
  },
};

export const ConfirmActionModal: React.FC<Props> = ({ request, onClose }) => {
  const config = typeConfig[request.type] || typeConfig.warning;

  const handleConfirm = async () => {
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.CONFIRM_ACTION_RESPONSE, {
        requestId: request.id,
        confirmed: true,
      });
      onClose();
    } catch (error) {
      logger.error('Failed to send confirm response', error);
    }
  };

  const handleCancel = async () => {
    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.CONFIRM_ACTION_RESPONSE, {
        requestId: request.id,
        confirmed: false,
      });
      onClose();
    } catch (error) {
      logger.error('Failed to send cancel response', error);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={handleCancel}
      size="md"
      title={request.title}
      headerBgClass={config.headerBg}
      headerIcon={
        <div className={`p-2 rounded-lg ${config.iconBg} ${config.iconColor}`}>
          {config.icon}
        </div>
      }
      footer={
        <ModalFooter
          cancelText={request.cancelText}
          confirmText={request.confirmText}
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          confirmColorClass={config.confirmBg}
        />
      }
    >
      {/* Message with proper whitespace handling */}
      <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
        {request.message}
      </div>
    </Modal>
  );
};

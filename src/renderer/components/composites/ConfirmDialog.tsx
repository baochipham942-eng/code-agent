// ============================================================================
// ConfirmDialog - Confirmation dialog built on Modal
// ============================================================================

import React from 'react';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { Modal, ModalFooter } from '../primitives/Modal';

export type ConfirmDialogVariant = 'info' | 'warning' | 'danger';

const variantConfig: Record<
  ConfirmDialogVariant,
  {
    icon: React.ReactNode;
    iconBgClass: string;
    iconColorClass: string;
    confirmColorClass: string;
  }
> = {
  info: {
    icon: <Info className="w-6 h-6" />,
    iconBgClass: 'bg-blue-500/10',
    iconColorClass: 'text-blue-400',
    confirmColorClass: 'bg-blue-600 hover:bg-blue-500',
  },
  warning: {
    icon: <AlertTriangle className="w-6 h-6" />,
    iconBgClass: 'bg-amber-500/10',
    iconColorClass: 'text-amber-400',
    confirmColorClass: 'bg-amber-600 hover:bg-amber-500',
  },
  danger: {
    icon: <ShieldAlert className="w-6 h-6" />,
    iconBgClass: 'bg-red-500/10',
    iconColorClass: 'text-red-400',
    confirmColorClass: 'bg-red-600 hover:bg-red-500',
  },
};

export interface ConfirmDialogProps {
  /** Dialog visibility */
  isOpen: boolean;
  /** Dialog title */
  title: string;
  /** Dialog message (can be string or ReactNode) */
  message: string | React.ReactNode;
  /** Visual variant */
  variant?: ConfirmDialogVariant;
  /** Confirm button text */
  confirmText?: string;
  /** Cancel button text */
  cancelText?: string;
  /** Confirm callback */
  onConfirm: () => void;
  /** Cancel/close callback */
  onCancel: () => void;
  /** If true, only show confirm button (no cancel) */
  singleAction?: boolean;
  /** Custom icon override */
  icon?: React.ReactNode;
  /** Whether confirm button is disabled */
  confirmDisabled?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  variant = 'warning',
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
  singleAction = false,
  icon,
  confirmDisabled = false,
}) => {
  const config = variantConfig[variant];
  const displayIcon = icon || config.icon;

  return (
    <Modal
      isOpen={isOpen}
      onClose={singleAction ? undefined : onCancel}
      title={title}
      size="md"
      closeOnBackdropClick={!singleAction}
      closeOnEsc={!singleAction}
      showCloseButton={!singleAction}
      headerIcon={
        <div className={`p-2 rounded-lg ${config.iconBgClass} ${config.iconColorClass}`}>
          {displayIcon}
        </div>
      }
      footer={
        <ModalFooter
          cancelText={cancelText}
          confirmText={confirmText}
          onCancel={singleAction ? undefined : onCancel}
          onConfirm={onConfirm}
          confirmColorClass={config.confirmColorClass}
          confirmDisabled={confirmDisabled}
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

export default ConfirmDialog;

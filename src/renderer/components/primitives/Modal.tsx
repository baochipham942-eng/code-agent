// ============================================================================
// Modal - Base modal component with customizable size and layout
// ============================================================================

import React, { useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

const sizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  full: 'max-w-4xl',
};

export interface ModalProps {
  /** Modal visibility */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose?: () => void;
  /** Modal title displayed in header */
  title?: string;
  /** Modal size variant */
  size?: ModalSize;
  /** Whether clicking backdrop closes modal */
  closeOnBackdropClick?: boolean;
  /** Whether pressing ESC closes modal */
  closeOnEsc?: boolean;
  /** Whether to show close button in header */
  showCloseButton?: boolean;
  /** Custom header content (replaces default title) */
  header?: React.ReactNode;
  /** Custom footer content */
  footer?: React.ReactNode;
  /** Header background color class */
  headerBgClass?: string;
  /** Header icon */
  headerIcon?: React.ReactNode;
  /** Additional class for modal container */
  className?: string;
  /** Modal content */
  children: React.ReactNode;
  /** Z-index level (default: 50) */
  zIndex?: number;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  size = 'md',
  closeOnBackdropClick = true,
  closeOnEsc = true,
  showCloseButton = true,
  header,
  footer,
  headerBgClass,
  headerIcon,
  className = '',
  children,
  zIndex = 50,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);

  // ESC key handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEsc && onClose) {
        onClose();
      }
    },
    [closeOnEsc, onClose]
  );

  // Register/unregister ESC listener
  useEffect(() => {
    if (isOpen && closeOnEsc) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, closeOnEsc, handleKeyDown]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [isOpen]);

  // Focus trap - focus modal on open
  useEffect(() => {
    if (isOpen && modalRef.current) {
      modalRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdropClick = () => {
    if (closeOnBackdropClick && onClose) {
      onClose();
    }
  };

  const handleModalClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const zIndexStyle = { zIndex };

  return (
    <div className="fixed inset-0 flex items-center justify-center" style={zIndexStyle}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleBackdropClick}
      />

      {/* Modal container */}
      <div
        ref={modalRef}
        tabIndex={-1}
        className={`relative w-full ${sizeClasses[size]} bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl overflow-hidden animate-fadeIn outline-none ${className}`}
        onClick={handleModalClick}
      >
        {/* Header */}
        {(header || title) && (
          <div
            className={`flex items-center gap-3 px-6 py-4 border-b border-zinc-800 ${headerBgClass || ''}`}
          >
            {header ? (
              header
            ) : (
              <>
                {headerIcon && (
                  <div className="shrink-0">{headerIcon}</div>
                )}
                <h2 className="flex-1 text-lg font-semibold text-zinc-100">
                  {title}
                </h2>
                {showCloseButton && onClose && (
                  <button
                    onClick={onClose}
                    className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
                    aria-label="Close modal"
                  >
                    <X className="w-5 h-5" />
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* Content */}
        <div className="px-6 py-4">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="px-6 py-4 border-t border-zinc-800 flex justify-end gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// ModalHeader - Custom header component for complex headers
// ============================================================================

export interface ModalHeaderProps {
  /** Header icon */
  icon?: React.ReactNode;
  /** Icon container background class */
  iconBgClass?: string;
  /** Icon color class */
  iconColorClass?: string;
  /** Main title */
  title: string;
  /** Subtitle under title */
  subtitle?: string;
  /** Whether to show close button */
  showCloseButton?: boolean;
  /** Close callback */
  onClose?: () => void;
  /** Children (rendered after title) */
  children?: React.ReactNode;
}

export const ModalHeader: React.FC<ModalHeaderProps> = ({
  icon,
  iconBgClass = 'bg-zinc-800',
  iconColorClass = 'text-zinc-400',
  title,
  subtitle,
  showCloseButton = true,
  onClose,
  children,
}) => {
  return (
    <>
      {icon && (
        <div className={`p-2 rounded-lg ${iconBgClass} ${iconColorClass}`}>
          {icon}
        </div>
      )}
      <div className="flex-1">
        <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
        {subtitle && <p className="text-xs text-zinc-400">{subtitle}</p>}
        {children}
      </div>
      {showCloseButton && onClose && (
        <button
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
          aria-label="Close modal"
        >
          <X className="w-5 h-5" />
        </button>
      )}
    </>
  );
};

// ============================================================================
// ModalFooter - Standard footer with cancel/confirm buttons
// ============================================================================

export interface ModalFooterProps {
  /** Cancel button text */
  cancelText?: string;
  /** Confirm button text */
  confirmText?: string;
  /** Cancel callback */
  onCancel?: () => void;
  /** Confirm callback */
  onConfirm?: () => void;
  /** Confirm button color class */
  confirmColorClass?: string;
  /** Whether confirm button is disabled */
  confirmDisabled?: boolean;
  /** Whether to hide cancel button */
  hideCancel?: boolean;
  /** Custom content (replaces default buttons) */
  children?: React.ReactNode;
}

export const ModalFooter: React.FC<ModalFooterProps> = ({
  cancelText = '取消',
  confirmText = '确认',
  onCancel,
  onConfirm,
  confirmColorClass = 'bg-blue-600 hover:bg-blue-500',
  confirmDisabled = false,
  hideCancel = false,
  children,
}) => {
  if (children) {
    return <>{children}</>;
  }

  return (
    <>
      {!hideCancel && onCancel && (
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
        >
          {cancelText}
        </button>
      )}
      {onConfirm && (
        <button
          onClick={onConfirm}
          disabled={confirmDisabled}
          className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors ${
            confirmDisabled
              ? 'bg-zinc-700 text-zinc-500 cursor-not-allowed'
              : confirmColorClass
          }`}
        >
          {confirmText}
        </button>
      )}
    </>
  );
};

export default Modal;

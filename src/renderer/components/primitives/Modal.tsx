// ============================================================================
// Modal - Base modal component with customizable size and layout
// ============================================================================

import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

type EscapeHandlerRef = { current: () => void };

const modalStack: string[] = [];
const modalEscapeHandlers = new Map<string, EscapeHandlerRef>();

const handleDocumentKeyDown = (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;

  const topmostModalId = modalStack[modalStack.length - 1];
  if (topmostModalId) {
    modalEscapeHandlers.get(topmostModalId)?.current();
  }
};

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full' | 'viewport';

const sizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  full: 'max-w-4xl',
  viewport: 'max-w-none h-full',
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
  const modalId = useId();
  const headerId = useId();
  const escapeHandlerRef = useRef<() => void>(() => undefined);

  escapeHandlerRef.current = () => {
    if (closeOnEsc && onClose) {
      onClose();
    }
  };

  // Coordinate Escape handling and body scroll across stacked modals.
  useEffect(() => {
    if (!isOpen) return;

    if (modalStack.length === 0) {
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', handleDocumentKeyDown);
    }

    modalStack.push(modalId);
    modalEscapeHandlers.set(modalId, escapeHandlerRef);

    return () => {
      const stackIndex = modalStack.lastIndexOf(modalId);
      if (stackIndex !== -1) {
        modalStack.splice(stackIndex, 1);
      }
      modalEscapeHandlers.delete(modalId);

      if (modalStack.length === 0) {
        document.body.style.overflow = '';
        document.removeEventListener('keydown', handleDocumentKeyDown);
      }
    };
  }, [isOpen, modalId]);

  // Focus modal on open and restore focus on close
  useEffect(() => {
    if (isOpen && modalRef.current) {
      const previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      modalRef.current.focus();

      return () => {
        if (previouslyFocused?.isConnected) {
          previouslyFocused.focus();
        }
      };
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

  const handleModalKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !modalRef.current) return;

    const focusableElements = Array.from(
      modalRef.current.querySelectorAll<HTMLElement>(focusableSelector)
    );

    if (focusableElements.length === 0) {
      e.preventDefault();
      modalRef.current.focus();
      return;
    }

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];

    if (e.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
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
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-labelledby={!title && header ? headerId : undefined}
        className={`relative w-full ${sizeClasses[size]} ${size === 'viewport' ? 'max-h-none rounded-none' : 'max-h-[90vh] rounded-xl'} flex flex-col bg-zinc-900 border border-zinc-700 shadow-2xl overflow-hidden animate-fadeIn outline-hidden ${className}`}
        onClick={handleModalClick}
        onKeyDown={handleModalKeyDown}
      >
        {/* Header */}
        {(header || title) && (
          <div
            id={!title && header ? headerId : undefined}
            className={`flex items-center gap-3 px-6 py-4 border-b border-zinc-700 shrink-0 ${headerBgClass || ''}`}
          >
            {header ? (
              header
            ) : (
              <>
                {headerIcon && (
                  <div className="shrink-0">{headerIcon}</div>
                )}
                <h2 className="flex-1 text-lg font-semibold text-zinc-200">
                  {title}
                </h2>
                {showCloseButton && onClose && (
                  <button
                    onClick={onClose}
                    className="p-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                    aria-label="关闭"
                  >
                    <X className="w-5 h-5" />
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* Content */}
        <div className="px-6 py-4 overflow-y-auto min-h-0 flex-1">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="px-6 py-4 border-t border-zinc-700 flex justify-end gap-3 shrink-0">
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
  iconBgClass = 'bg-zinc-700',
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
        <h2 className="text-lg font-semibold text-zinc-200">{title}</h2>
        {subtitle && <p className="text-xs text-zinc-400">{subtitle}</p>}
        {children}
      </div>
      {showCloseButton && onClose && (
        <button
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
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
          className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded-lg transition-colors"
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
              ? 'bg-zinc-600 text-zinc-500 cursor-not-allowed'
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

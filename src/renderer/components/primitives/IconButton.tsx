// ============================================================================
// IconButton - Icon-only Button Component
// ============================================================================

import React, { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

export type IconButtonVariant = 'default' | 'ghost' | 'danger' | 'active' | 'outline';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style variant */
  variant?: IconButtonVariant;
  /** Size of the button */
  size?: IconButtonSize;
  /** Show loading spinner and disable button */
  loading?: boolean;
  /** Icon to display */
  icon: React.ReactNode;
  /** Accessible label (required for icon-only buttons) */
  'aria-label': string;
  /** Disable window drag (for Electron title bar) */
  windowNoDrag?: boolean;
}

// ============================================================================
// Style Configuration
// ============================================================================

const variantStyles: Record<IconButtonVariant, string> = {
  default: [
    'bg-transparent hover:bg-zinc-800',
    'text-zinc-400 hover:text-zinc-100',
    'disabled:text-zinc-600',
  ].join(' '),
  ghost: [
    'bg-transparent hover:bg-zinc-700/50',
    'text-zinc-500 hover:text-zinc-300',
    'disabled:text-zinc-600',
  ].join(' '),
  danger: [
    'bg-transparent hover:bg-red-500/10',
    'text-zinc-500 hover:text-red-400',
    'disabled:text-zinc-600',
  ].join(' '),
  active: [
    'bg-blue-500/20',
    'text-blue-400',
    'disabled:text-blue-400/50',
  ].join(' '),
  outline: [
    'bg-transparent hover:bg-white/5',
    'text-zinc-400 hover:text-zinc-200',
    'border border-white/10 hover:border-white/20',
    'disabled:text-zinc-600',
  ].join(' '),
};

const sizeStyles: Record<IconButtonSize, string> = {
  sm: 'p-1',
  md: 'p-1.5',
  lg: 'p-2',
};

const iconSizeStyles: Record<IconButtonSize, string> = {
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
};

// ============================================================================
// Component
// ============================================================================

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      variant = 'default',
      size = 'md',
      loading = false,
      icon,
      windowNoDrag = false,
      disabled,
      className = '',
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading;

    const baseStyles = [
      'inline-flex items-center justify-center',
      'rounded-md',
      'transition-colors duration-200',
      'focus:outline-none focus:ring-2 focus:ring-primary-500/30',
      'disabled:opacity-50 disabled:cursor-not-allowed',
    ].join(' ');

    const iconSize = iconSizeStyles[size];

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={[
          baseStyles,
          variantStyles[variant],
          sizeStyles[size],
          windowNoDrag ? 'window-no-drag' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        {...props}
      >
        {loading ? (
          <Loader2 className={`${iconSize} animate-spin`} />
        ) : (
          <span className={iconSize}>{icon}</span>
        )}
      </button>
    );
  }
);

IconButton.displayName = 'IconButton';

// ============================================================================
// Common Icon Button Patterns
// ============================================================================

/** Close button with X icon styling */
export interface CloseButtonProps extends Omit<IconButtonProps, 'icon' | 'aria-label'> {
  /** Override default aria-label */
  'aria-label'?: string;
}

export const CloseButton = forwardRef<HTMLButtonElement, CloseButtonProps>(
  ({ 'aria-label': ariaLabel = 'Close', ...props }, ref) => {
    // Using inline SVG to avoid lucide-react import dependency
    const XIcon = (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-full h-full"
      >
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    );

    return (
      <IconButton
        ref={ref}
        icon={XIcon}
        aria-label={ariaLabel}
        {...props}
      />
    );
  }
);

CloseButton.displayName = 'CloseButton';

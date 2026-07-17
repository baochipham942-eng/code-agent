// ============================================================================
// Button - Reusable Button Component
// ============================================================================

import React, { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style variant */
  variant?: ButtonVariant;
  /** Size of the button */
  size?: ButtonSize;
  /** Show loading spinner and disable button */
  loading?: boolean;
  /** Icon to display before children */
  leftIcon?: React.ReactNode;
  /** Icon to display after children */
  rightIcon?: React.ReactNode;
  /** Make button full width */
  fullWidth?: boolean;
}

// ============================================================================
// Style Configuration
// ============================================================================

const variantStyles: Record<ButtonVariant, string> = {
  primary: [
    // teal-800→700 渐变：白字对比度浅端 5.47:1 / 深端 7.58:1（WCAG AA），勿回浅色系
    'bg-gradient-to-r from-primary-800 to-primary-700',
    'hover:from-primary-700 hover:to-primary-600',
    'text-white',
    'shadow-lg shadow-primary-700/20 hover:shadow-primary-700/30',
    'disabled:from-primary-800/50 disabled:to-primary-700/50',
  ].join(' '),
  secondary: [
    'bg-zinc-600 hover:bg-zinc-500',
    'text-zinc-200',
    'disabled:bg-zinc-700',
  ].join(' '),
  ghost: [
    'bg-transparent hover:bg-zinc-700',
    'text-zinc-400 hover:text-zinc-200',
    'disabled:text-zinc-600',
  ].join(' '),
  danger: [
    'bg-red-600 hover:bg-red-500',
    'text-white',
    'disabled:bg-red-600/50',
  ].join(' '),
};

// 收敛源：其他地方（如 Modal/ConfirmDialog 的手搓 confirm 按钮）复用这两个类串，
// 别各自维护一份颜色字面量、慢慢和 Button 视觉漂移。
export const BUTTON_PRIMARY_CLASS = variantStyles.primary;
export const BUTTON_DANGER_CLASS = variantStyles.danger;

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
  lg: 'px-6 py-2.5 text-base gap-2',
};

const iconSizeStyles: Record<ButtonSize, string> = {
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
};

// ============================================================================
// Component
// ============================================================================

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      leftIcon,
      rightIcon,
      fullWidth = false,
      disabled,
      className = '',
      children,
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading;

    const baseStyles = [
      'inline-flex items-center justify-center',
      'font-medium',
      'rounded-lg',
      'transition-all duration-200',
      'focus:outline-hidden',
      'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      'active:scale-[0.98]',
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
          fullWidth ? 'w-full' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        {...props}
      >
        {loading ? (
          <Loader2 className={`${iconSize} animate-spin`} />
        ) : (
          leftIcon && <span className={iconSize}>{leftIcon}</span>
        )}
        {children && <span>{children}</span>}
        {!loading && rightIcon && <span className={iconSize}>{rightIcon}</span>}
      </button>
    );
  }
);

Button.displayName = 'Button';

// ============================================================================
// Semantic Variants for Common Use Cases
// ============================================================================

/** Primary action button with gradient */
export const PrimaryButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'variant'>>(
  (props, ref) => <Button ref={ref} variant="primary" {...props} />
);
PrimaryButton.displayName = 'PrimaryButton';

/** Secondary action button */
export const SecondaryButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'variant'>>(
  (props, ref) => <Button ref={ref} variant="secondary" {...props} />
);
SecondaryButton.displayName = 'SecondaryButton';

/** Ghost button for subtle actions */
export const GhostButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'variant'>>(
  (props, ref) => <Button ref={ref} variant="ghost" {...props} />
);
GhostButton.displayName = 'GhostButton';

/** Danger button for destructive actions */
export const DangerButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'variant'>>(
  (props, ref) => <Button ref={ref} variant="danger" {...props} />
);
DangerButton.displayName = 'DangerButton';

// ============================================================================
// Input - Reusable input component
// ============================================================================

import React, { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export type InputType = 'text' | 'password' | 'search' | 'email' | 'number';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Input type */
  type?: InputType;
  /** Error state */
  error?: boolean;
  /** Error message (also triggers error state) */
  errorMessage?: string;
  /** Left icon */
  leftIcon?: ReactNode;
  /** Right icon */
  rightIcon?: ReactNode;
  /** Full width */
  fullWidth?: boolean;
  /** Input size variant */
  inputSize?: 'sm' | 'md' | 'lg';
}

const sizeClasses = {
  sm: 'py-1.5 text-xs',
  md: 'py-2 text-sm',
  lg: 'py-2.5 text-base',
};

const iconSizeClasses = {
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-5 h-5',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      type = 'text',
      error,
      errorMessage,
      leftIcon,
      rightIcon,
      fullWidth = true,
      inputSize = 'md',
      className = '',
      disabled,
      ...props
    },
    ref
  ) => {
    const hasError = error || !!errorMessage;

    const baseClasses = [
      'bg-zinc-800',
      'border',
      'rounded-lg',
      'text-zinc-100',
      'placeholder:text-zinc-500',
      'focus:outline-none',
      'transition-colors',
      sizeClasses[inputSize],
    ];

    // Border and focus styles
    if (hasError) {
      baseClasses.push('border-red-500', 'focus:border-red-400', 'focus:ring-2', 'focus:ring-red-500/50');
    } else {
      baseClasses.push('border-zinc-700', 'focus:border-zinc-600', 'focus:ring-2', 'focus:ring-blue-500/50', 'focus:border-blue-500');
    }

    // Disabled styles
    if (disabled) {
      baseClasses.push('opacity-50', 'cursor-not-allowed');
    }

    // Width
    if (fullWidth) {
      baseClasses.push('w-full');
    }

    // Padding based on icons
    const paddingLeft = leftIcon ? 'pl-10' : 'px-4';
    const paddingRight = rightIcon ? 'pr-10' : 'px-4';
    baseClasses.push(paddingLeft, paddingRight);

    return (
      <div className={`relative ${fullWidth ? 'w-full' : 'inline-block'}`}>
        {leftIcon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none">
            <span className={iconSizeClasses[inputSize]}>{leftIcon}</span>
          </div>
        )}
        <input
          ref={ref}
          type={type}
          disabled={disabled}
          className={`${baseClasses.join(' ')} ${className}`}
          {...props}
        />
        {rightIcon && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none">
            <span className={iconSizeClasses[inputSize]}>{rightIcon}</span>
          </div>
        )}
        {errorMessage && (
          <p className="mt-1 text-xs text-red-400">{errorMessage}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export default Input;

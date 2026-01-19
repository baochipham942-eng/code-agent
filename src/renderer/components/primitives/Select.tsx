// ============================================================================
// Select - Reusable select component
// ============================================================================

import React, { forwardRef, type SelectHTMLAttributes, type ReactNode } from 'react';

export interface SelectOption {
  /** Option value */
  value: string;
  /** Display label */
  label: string;
  /** Disabled state */
  disabled?: boolean;
}

export interface SelectOptionGroup {
  /** Group label */
  label: string;
  /** Options in this group */
  options: SelectOption[];
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  /** Options array */
  options?: SelectOption[];
  /** Option groups (for grouped options) */
  optionGroups?: SelectOptionGroup[];
  /** Placeholder text (shown as first disabled option) */
  placeholder?: string;
  /** Error state */
  error?: boolean;
  /** Error message (also triggers error state) */
  errorMessage?: string;
  /** Full width */
  fullWidth?: boolean;
  /** Select size variant */
  selectSize?: 'sm' | 'md' | 'lg';
  /** Children for custom option rendering */
  children?: ReactNode;
}

const sizeClasses = {
  sm: 'py-1.5 text-xs',
  md: 'py-2 text-sm',
  lg: 'py-2.5 text-base',
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      options,
      optionGroups,
      placeholder,
      error,
      errorMessage,
      fullWidth = true,
      selectSize = 'md',
      className = '',
      disabled,
      children,
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
      'focus:outline-none',
      'transition-colors',
      'px-4',
      sizeClasses[selectSize],
      // Custom arrow
      'appearance-none',
      'bg-no-repeat',
      'bg-right',
      'pr-10',
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

    // Render options helper
    const renderOptions = () => {
      // If children provided, use them directly
      if (children) return children;

      const result: ReactNode[] = [];

      // Add placeholder as first option
      if (placeholder) {
        result.push(
          <option key="__placeholder__" value="" disabled>
            {placeholder}
          </option>
        );
      }

      // Add flat options
      if (options) {
        options.forEach((opt) => {
          result.push(
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          );
        });
      }

      // Add grouped options
      if (optionGroups) {
        optionGroups.forEach((group) => {
          result.push(
            <optgroup key={group.label} label={group.label}>
              {group.options.map((opt) => (
                <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                  {opt.label}
                </option>
              ))}
            </optgroup>
          );
        });
      }

      return result;
    };

    return (
      <div className={`relative ${fullWidth ? 'w-full' : 'inline-block'}`}>
        <select
          ref={ref}
          disabled={disabled}
          className={`${baseClasses.join(' ')} ${className}`}
          style={{
            backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`,
            backgroundPosition: 'right 0.75rem center',
            backgroundSize: '1.25em 1.25em',
          }}
          {...props}
        >
          {renderOptions()}
        </select>
        {errorMessage && (
          <p className="mt-1 text-xs text-red-400">{errorMessage}</p>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';

export default Select;

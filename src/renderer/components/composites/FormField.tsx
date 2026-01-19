// ============================================================================
// FormField - Composite component combining Label + Input + Error message
// ============================================================================

import React, { type ReactNode, type ReactElement, cloneElement, isValidElement } from 'react';
import { Input, type InputProps } from '../primitives/Input';
import { Textarea, type TextareaProps } from '../primitives/Textarea';
import { Select, type SelectProps } from '../primitives/Select';

export interface FormFieldProps {
  /** Field label */
  label: string;
  /** Whether the field is required */
  required?: boolean;
  /** Error message */
  error?: string;
  /** Hint text below the input */
  hint?: string;
  /** Additional className for the wrapper */
  className?: string;
  /** Children (Input, Textarea, or Select) */
  children: ReactElement<InputProps | TextareaProps | SelectProps>;
  /** Label size */
  labelSize?: 'sm' | 'md';
  /** HTML id for the input (for label association) */
  htmlFor?: string;
}

export const FormField: React.FC<FormFieldProps> = ({
  label,
  required = false,
  error,
  hint,
  className = '',
  children,
  labelSize = 'sm',
  htmlFor,
}) => {
  const labelClasses = labelSize === 'sm'
    ? 'text-sm text-zinc-400'
    : 'text-sm font-medium text-zinc-100';

  // Clone child and inject error prop
  const enhancedChild = isValidElement(children)
    ? cloneElement(children, {
        error: !!error,
        errorMessage: undefined, // We'll show error below
        id: htmlFor,
        ...children.props,
      } as Partial<InputProps | TextareaProps | SelectProps>)
    : children;

  return (
    <div className={className}>
      <label
        className={`block ${labelClasses} mb-1`}
        htmlFor={htmlFor}
      >
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {enhancedChild}
      {hint && !error && (
        <p className="mt-1 text-xs text-zinc-500">{hint}</p>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-400">{error}</p>
      )}
    </div>
  );
};

// Re-export primitives for convenience
export { Input, Textarea, Select };
export type { InputProps, TextareaProps, SelectProps };

export default FormField;

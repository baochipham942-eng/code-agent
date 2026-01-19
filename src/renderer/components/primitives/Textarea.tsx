// ============================================================================
// Textarea - Reusable textarea component with auto-resize
// ============================================================================

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type TextareaHTMLAttributes,
} from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Auto-resize based on content */
  autoResize?: boolean;
  /** Minimum number of rows */
  minRows?: number;
  /** Maximum number of rows */
  maxRows?: number;
  /** Error state */
  error?: boolean;
  /** Error message (also triggers error state) */
  errorMessage?: string;
  /** Full width */
  fullWidth?: boolean;
}

// Line height in pixels (approximate, based on text-sm)
const LINE_HEIGHT = 20;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      autoResize = false,
      minRows = 3,
      maxRows = 10,
      error,
      errorMessage,
      fullWidth = true,
      className = '',
      disabled,
      value,
      onChange,
      ...props
    },
    ref
  ) => {
    const internalRef = useRef<HTMLTextAreaElement>(null);
    const textareaRef = (ref as React.RefObject<HTMLTextAreaElement>) || internalRef;
    const hasError = error || !!errorMessage;

    const adjustHeight = useCallback(() => {
      const textarea = textareaRef.current;
      if (!textarea || !autoResize) return;

      // Reset height to get accurate scrollHeight
      textarea.style.height = 'auto';

      // Calculate min and max heights
      const minHeight = minRows * LINE_HEIGHT + 16; // 16px for padding
      const maxHeight = maxRows * LINE_HEIGHT + 16;

      // Get the scroll height
      const scrollHeight = textarea.scrollHeight;

      // Clamp to min/max
      const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
      textarea.style.height = `${newHeight}px`;

      // Show scrollbar if content exceeds maxHeight
      textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
    }, [autoResize, minRows, maxRows, textareaRef]);

    // Adjust height when value changes
    useEffect(() => {
      adjustHeight();
    }, [value, adjustHeight]);

    // Adjust on mount
    useEffect(() => {
      adjustHeight();
    }, [adjustHeight]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange?.(e);
      if (autoResize) {
        adjustHeight();
      }
    };

    const baseClasses = [
      'bg-zinc-800',
      'border',
      'rounded-lg',
      'text-sm',
      'text-zinc-100',
      'placeholder:text-zinc-500',
      'focus:outline-none',
      'transition-colors',
      'px-4',
      'py-2',
      'resize-none',
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

    return (
      <div className={fullWidth ? 'w-full' : 'inline-block'}>
        <textarea
          ref={textareaRef}
          disabled={disabled}
          value={value}
          onChange={handleChange}
          rows={autoResize ? minRows : undefined}
          className={`${baseClasses.join(' ')} ${className}`}
          {...props}
        />
        {errorMessage && (
          <p className="mt-1 text-xs text-red-400">{errorMessage}</p>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

export default Textarea;

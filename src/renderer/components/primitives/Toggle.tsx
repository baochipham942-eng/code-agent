// ============================================================================
// Toggle - 开关组件
// ============================================================================

import React from 'react';

export type ToggleSize = 'sm' | 'md';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: ToggleSize;
  disabled?: boolean;
  'aria-label'?: string;
  title?: string;
}

const SIZE_CLASSES: Record<ToggleSize, { track: string; thumb: string; translate: string }> = {
  sm: {
    track: 'h-5 w-9',
    thumb: 'h-4 w-4',
    translate: 'translate-x-4',
  },
  md: {
    track: 'h-6 w-12',
    thumb: 'h-5 w-5',
    translate: 'translate-x-6',
  },
};

export const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  size = 'sm',
  disabled = false,
  'aria-label': ariaLabel,
  title,
}) => {
  const sizeClasses = SIZE_CLASSES[size];

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 ${sizeClasses.track} ${
        checked ? 'bg-primary-500' : 'bg-zinc-600'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 rounded-full bg-white shadow-sm transition-transform ${sizeClasses.thumb} ${
          checked ? sizeClasses.translate : 'translate-x-0'
        }`}
      />
    </button>
  );
};

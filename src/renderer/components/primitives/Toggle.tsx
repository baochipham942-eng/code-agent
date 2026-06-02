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
}) => {
  const sizeClasses = SIZE_CLASSES[size];

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors focus:outline-hidden ${sizeClasses.track} ${
        checked ? 'bg-emerald-500' : 'bg-zinc-600'
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

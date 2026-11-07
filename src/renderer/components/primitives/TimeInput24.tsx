import React from 'react';
import { Select } from './Select';

const HOURS = Array.from({ length: 24 }, (_, hour) => {
  const value = String(hour).padStart(2, '0');
  return { value, label: value };
});

const MINUTES = Array.from({ length: 60 }, (_, minute) => {
  const value = String(minute).padStart(2, '0');
  return { value, label: value };
});

export interface TimeInput24Props {
  value: string;
  onChange: (value: string) => void;
  hourLabel: string;
  minuteLabel: string;
  testId: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

function partsFromValue(value: string): [string, string] {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return ['00', '00'];
  return [match[1], match[2]];
}

export const TimeInput24: React.FC<TimeInput24Props> = ({
  value,
  onChange,
  hourLabel,
  minuteLabel,
  testId,
  disabled = false,
  size = 'md',
}) => {
  const [hour, minute] = partsFromValue(value);

  return (
    <div data-testid={testId} className="flex items-center gap-1.5">
      <Select
        data-testid={`${testId}-hour`}
        aria-label={hourLabel}
        value={hour}
        options={HOURS}
        disabled={disabled}
        fullWidth={false}
        selectSize={size}
        className="!w-auto"
        onChange={(event) => onChange(`${event.target.value}:${minute}`)}
      />
      <span aria-hidden="true" className="text-zinc-500">:</span>
      <Select
        data-testid={`${testId}-minute`}
        aria-label={minuteLabel}
        value={minute}
        options={MINUTES}
        disabled={disabled}
        fullWidth={false}
        selectSize={size}
        className="!w-auto"
        onChange={(event) => onChange(`${hour}:${event.target.value}`)}
      />
    </div>
  );
};

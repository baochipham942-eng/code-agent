// @vitest-environment jsdom

import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeInput24 } from '../../../src/renderer/components/primitives/TimeInput24';

function stubTwelveHourLocale(): void {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    locale: 'en-US',
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h12',
    hour12: true,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TimeInput24', () => {
  it('pins hour and minute selects to 24-hour digits even in an en-US h12 locale', () => {
    stubTwelveHourLocale();
    const onChange = vi.fn();

    const Harness = () => {
      const [value, setValue] = useState('');
      return (
        <TimeInput24
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          hourLabel="Hour"
          minuteLabel="Minute"
          testId="time"
        />
      );
    };

    const { container } = render(<Harness />);
    expect(navigator.language).toBe('en-US');
    expect(new Intl.DateTimeFormat().resolvedOptions().hourCycle).toBe('h12');
    expect(container.querySelector('input[type="time"]')).toBeNull();
    expect(screen.getByTestId('time').textContent).not.toMatch(/AM|PM/i);

    const hour = screen.getByTestId('time-hour') as HTMLSelectElement;
    const minute = screen.getByTestId('time-minute') as HTMLSelectElement;
    expect(hour.value).toBe('00');
    expect(minute.value).toBe('00');
    expect(onChange).not.toHaveBeenCalled();
    expect(Array.from(hour.options, (option) => option.textContent)).toEqual(
      Array.from({ length: 24 }, (_, value) => String(value).padStart(2, '0')),
    );
    expect(Array.from(minute.options, (option) => option.textContent)).not.toContain('AM');
    expect(Array.from(minute.options, (option) => option.textContent)).not.toContain('PM');

    fireEvent.change(hour, { target: { value: '07' } });
    fireEvent.change(minute, { target: { value: '30' } });
    expect(onChange).toHaveBeenLastCalledWith('07:30');
  });

  it('echoes an existing HH:mm value without emitting on render', () => {
    const onChange = vi.fn();
    render(
      <TimeInput24
        value="22:00"
        onChange={onChange}
        hourLabel="Hour"
        minuteLabel="Minute"
        testId="time"
      />,
    );

    expect(screen.getByTestId('time-hour')).toHaveProperty('value', '22');
    expect(screen.getByTestId('time-minute')).toHaveProperty('value', '00');
    expect(onChange).not.toHaveBeenCalled();
  });
});

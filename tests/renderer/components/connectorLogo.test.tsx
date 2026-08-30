// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Plug } from 'lucide-react';
import { ConnectorLogo } from '../../../src/renderer/components/features/connectors/ConnectorLogo';

describe('ConnectorLogo', () => {
  afterEach(cleanup);

  it('renders a declared PNG brand asset with the connector display name as alt text', () => {
    render(
      <ConnectorLogo
        id="feishu"
        displayName="飞书"
        fallback={<Plug data-testid="fallback-icon" />}
      />,
    );

    const logo = screen.getByRole('img', { name: '飞书' });
    expect(logo.getAttribute('src')).toMatch(/feishu\.png$/u);
    expect(screen.queryByTestId('fallback-icon')).toBeNull();
  });

  it('renders the Google Calendar brand asset', () => {
    render(
      <ConnectorLogo
        id="google-calendar"
        displayName="Google Calendar"
        fallback={<Plug data-testid="fallback-icon" />}
      />,
    );

    const logo = screen.getByRole('img', { name: 'Google Calendar' });
    expect(logo.getAttribute('src')).toMatch(/google-calendar\.png$/u);
    expect(screen.queryByTestId('fallback-icon')).toBeNull();
  });

  it('falls back to the existing icon when the logo field is absent', () => {
    render(
      <ConnectorLogo
        displayName="未声明品牌"
        fallback={<Plug data-testid="fallback-icon" />}
      />,
    );

    expect(screen.getByTestId('fallback-icon')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('falls back when a cloud catalog sends an unknown asset id', () => {
    render(
      <ConnectorLogo
        id="unknown-brand"
        displayName="未知品牌"
        fallback={<Plug data-testid="fallback-icon" />}
      />,
    );

    expect(screen.getByTestId('fallback-icon')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('applies the consumer size to the shared frame for both brand assets and fallbacks', () => {
    render(
      <div>
        <ConnectorLogo
          id="feishu"
          displayName="飞书"
          fallback={<Plug />}
          className="h-7 w-7"
        />
        <ConnectorLogo
          displayName="未声明品牌"
          fallback={<Plug data-testid="sized-fallback" className="h-7 w-7" />}
          className="h-7 w-7"
        />
      </div>,
    );

    const logo = screen.getByRole('img', { name: '飞书' });
    expect(logo.className).toContain('h-full');
    expect(logo.className).toContain('w-full');
    expect(logo.parentElement?.className).toContain('h-7');
    expect(logo.parentElement?.className).toContain('w-7');

    const fallback = screen.getByTestId('sized-fallback');
    expect(fallback.classList.contains('h-7')).toBe(true);
    expect(fallback.classList.contains('w-7')).toBe(true);
    expect(fallback.parentElement?.className).toContain('h-7');
    expect(fallback.parentElement?.className).toContain('w-7');
  });

  it('adds a light plate for the black GitHub mark', () => {
    const { container } = render(
      <ConnectorLogo id="github" displayName="GitHub" fallback={<Plug />} />,
    );

    expect(screen.getByRole('img', { name: 'GitHub' })).toBeTruthy();
    expect(container.querySelector('.bg-white')).toBeTruthy();
  });
});

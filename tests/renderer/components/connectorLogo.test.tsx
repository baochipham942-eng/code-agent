// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Plug } from 'lucide-react';
import { ConnectorLogo } from '../../../src/renderer/components/features/connectors/ConnectorLogo';

describe('ConnectorLogo', () => {
  afterEach(cleanup);

  it('renders a declared brand asset with the connector display name as alt text', () => {
    render(
      <ConnectorLogo
        id="tmeet"
        displayName="腾讯会议"
        fallback={<Plug data-testid="fallback-icon" />}
      />,
    );

    const logo = screen.getByRole('img', { name: '腾讯会议' });
    expect(logo.getAttribute('src')).toBeTruthy();
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

  it('adds a light plate for the black GitHub mark', () => {
    const { container } = render(
      <ConnectorLogo id="github" displayName="GitHub" fallback={<Plug />} />,
    );

    expect(screen.getByRole('img', { name: 'GitHub' })).toBeTruthy();
    expect(container.querySelector('.bg-white')).toBeTruthy();
  });
});

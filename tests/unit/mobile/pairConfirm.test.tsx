// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PairConfirm } from '../../../packages/mobile/src/features/settings/PairConfirm';
import { messages } from '../../../packages/mobile/src/i18n';
import { deriveInvitationVerify, formatInvitationVerify } from '../../../src/shared/companion/lanProtocol';

const zh = messages('zh');
const en = messages('en');
const psk = 'aa'.repeat(32);
const hostKey = 'bb'.repeat(32);
const verify = deriveInvitationVerify(psk, hostKey);

afterEach(cleanup);

describe('pairConfirm check-code screen', () => {
  it('shows the computer name, grouped check code, and the continue hint', () => {
    const onConfirm = vi.fn();
    const onReject = vi.fn();
    render(<PairConfirm name="linchens-macbook-pro" verify={verify} text={zh} onConfirm={onConfirm} onReject={onReject} />);
    expect(screen.getByTestId('pair-confirm').textContent).toContain(zh.pairConfirmTitle);
    expect(screen.getByText('linchens-macbook-pro')).toBeTruthy();
    expect(screen.getByTestId('pair-verify').textContent).toBe(formatInvitationVerify(verify));
    expect(screen.getByText(zh.pairConfirmVerify)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: zh.pairConfirmContinue }));
    fireEvent.click(screen.getByRole('button', { name: zh.pairConfirmReject }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it('keeps English copy on the same screen', () => {
    render(<PairConfirm name="This computer" verify={verify} text={en} onConfirm={() => {}} onReject={() => {}} />);
    expect(screen.getByText(en.pairConfirmTitle)).toBeTruthy();
    expect(screen.getByText(en.pairConfirmVerify)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.pairConfirmContinue })).toBeTruthy();
  });
});

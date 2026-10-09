import { describe, expect, it } from 'vitest';
import {
  buildCronLoginWallStopCode,
  isBrowserLoginWall,
  parseCronLoginWallStop,
} from '../../../../src/shared/utils/browserLoginWall';

describe('isBrowserLoginWall', () => {
  it.each([
    ['password input', { passwordInputPresent: true, loginFormPresent: false }],
    ['login form', { passwordInputPresent: false, loginFormPresent: true }],
  ])('requires login copy plus %s evidence', (_label, fields) => {
    expect(isBrowserLoginWall({
      title: 'Please sign in to continue',
      headings: [],
      visibleText: 'Your account is required.',
      ...fields,
    })).toBe(true);
  });

  it('does not classify a page with only a login link', () => {
    expect(isBrowserLoginWall({
      title: 'Home',
      headings: ['Sign in'],
      visibleText: 'Welcome. Sign in to view your account.',
      passwordInputPresent: false,
      loginFormPresent: false,
    })).toBe(false);
  });

  it('does not classify a password form without login-required copy', () => {
    expect(isBrowserLoginWall({
      title: 'Checkout',
      headings: ['Password reset'],
      visibleText: 'Enter your password.',
      passwordInputPresent: true,
      loginFormPresent: true,
    })).toBe(false);
  });
});

describe('cron login-wall stop code', () => {
  it('round-trips the site origin', () => {
    const code = buildCronLoginWallStopCode('https://example.test/account?next=1');
    expect(code).toBe('CRON_LOGIN_WALL_STOP|https://example.test');
    expect(parseCronLoginWallStop(code)).toEqual({ siteOrigin: 'https://example.test' });
    expect(parseCronLoginWallStop(`${code}; stop this unattended run`)).toEqual({
      siteOrigin: 'https://example.test',
    });
  });
});

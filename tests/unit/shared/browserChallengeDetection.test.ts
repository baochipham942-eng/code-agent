import { describe, expect, it } from 'vitest';
import { detectBrowserChallenge } from '../../../src/shared/utils/browserChallengeDetection';

const longBody = Array.from({ length: 40 }, (_, i) => `${i + 1}. Cloudflare outage and CAPTCHA tricks (example.com) 120 points`).join('\n');

describe('detectBrowserChallenge', () => {
  it('HN-like 长列表页：标题含 Cloudflare / CAPTCHA 不算挑战', () => {
    expect(detectBrowserChallenge({
      title: 'New Links | Hacker News',
      headings: ['CAPTCHA solvers compared'],
      bodyText: longBody,
      frameUrls: [],
    })).toBe(false);
  });
  it('挑战页标题命中', () => {
    expect(detectBrowserChallenge({ title: 'Just a moment...', bodyText: longBody })).toBe(true);
  });
  it('强短语标题行命中，裸词标题行不命中', () => {
    expect(detectBrowserChallenge({ title: 'x', headings: ['Please verify you are human'], bodyText: longBody })).toBe(true);
    expect(detectBrowserChallenge({ title: 'x', headings: ['Cloudflare'], bodyText: longBody })).toBe(false);
  });
  it('invisible reCAPTCHA frame 不算信号；可见 anchor frame 算', () => {
    const base = 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc&co=x';
    expect(detectBrowserChallenge({ title: 'Shop', bodyText: longBody, frameUrls: [`${base}&size=invisible`] })).toBe(false);
    expect(detectBrowserChallenge({ title: 'Shop', bodyText: longBody, frameUrls: [`${base}&size=normal`] })).toBe(true);
    expect(detectBrowserChallenge({ title: 'Shop', bodyText: longBody, frameUrls: ['https://newassets.hcaptcha.com/captcha/v1/x'] })).toBe(true);
  });
  it('短页面含 unusual traffic / 裸词命中', () => {
    expect(detectBrowserChallenge({ title: 'Sorry', bodyText: 'Our systems have detected unusual traffic from your network.' })).toBe(true);
    expect(detectBrowserChallenge({ title: 'x', bodyText: '请输入验证码' })).toBe(true);
  });
});

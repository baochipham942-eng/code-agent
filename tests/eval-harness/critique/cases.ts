import { directionTokens } from '../../../src/design/direction-tokens';
import type { BatchCase } from './batch';

export const CASES: BatchCase[] = [
  {
    id: 'editorial-portfolio-good',
    expectedDirection: 'editorial',
    expectedMin: 3.5,
    brief: {
      intent: 'Designer portfolio hero — quiet authority',
      surface: 'landing_page',
      direction: 'editorial',
      directionTokens: directionTokens.editorial,
      audience: 'agency hiring directors',
      constraints: ['must include a single hero headline', 'must support dark mode tokens'],
    },
    artifact: {
      kind: 'html',
      content: `<section class="hero" style="background: oklch(97% 0.014 80); color: oklch(22% 0.024 58); font-family: 'Newsreader', 'Iowan Old Style', Charter, Georgia, serif; padding: 96px 64px;">
  <p style="font-family: 'Söhne', system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.16em; font-size: 12px; color: oklch(50% 0.016 60);">Selected Work · 2024–2026</p>
  <h1 style="font-size: 72px; line-height: 1.05; margin: 24px 0 32px; max-width: 14ch;">Slow design for products that earn attention.</h1>
  <p style="font-family: 'Söhne', system-ui, sans-serif; font-size: 18px; line-height: 1.6; max-width: 60ch; color: oklch(22% 0.024 58);">A six-year archive of editorial systems, brand identities, and quiet interfaces — built with restraint, shipped with intent.</p>
</section>`,
      note: '一屏 hero，editorial 节奏：标题有重量、留白足够、Söhne sans 元数据 + Newsreader 标题、暗色字 + 米色底',
    },
  },
  {
    id: 'utilitarian-cluttered-bad',
    expectedDirection: 'utilitarian',
    brief: {
      intent: 'Internal admin dashboard summary card',
      surface: 'dashboard',
      direction: 'utilitarian',
      directionTokens: directionTokens.utilitarian,
      audience: 'operations team',
      constraints: ['must show 6 KPI numbers', 'no decorative imagery'],
    },
    artifact: {
      kind: 'html',
      content: `<div style="background: linear-gradient(135deg, oklch(58% 0.18 300), oklch(72% 0.18 72)); border-radius: 24px; padding: 48px; color: white; font-family: 'Fraunces', serif;">
  <h2 style="font-size: 56px; margin: 0;">✨ Today's Vibe ✨</h2>
  <p style="font-size: 24px; font-style: italic;">Operations is feeling fabulous! 🎉</p>
  <img src="/assets/sparkle-bg.gif" style="width: 100%;" />
  <button style="background: yellow; color: purple; border-radius: 999px; padding: 16px 32px; font-size: 20px;">Click me!</button>
</div>`,
      note: '故意错配：playful 的渐变 + emoji + Fraunces 衬线 + 装饰 gif，违背 utilitarian "刚好够用、不抢戏" 的 posture',
    },
  },
  {
    id: 'technical-status-grid',
    expectedDirection: 'technical',
    expectedMin: 3.0,
    brief: {
      intent: 'Status grid for distributed services',
      surface: 'dashboard',
      direction: 'technical',
      directionTokens: directionTokens.technical,
      audience: 'on-call engineers',
      constraints: ['每行展示 service name + region + p95 + error rate', 'monospace 数字'],
    },
    artifact: {
      kind: 'markdown',
      content: `## Service Status (last 5 min)

| Service | Region | p95 | Error rate | Status |
|---|---|---:|---:|:---:|
| auth-api | us-east-1 | 142ms | 0.03% | ● healthy |
| auth-api | eu-west-1 | 188ms | 0.07% | ● healthy |
| billing-svc | us-east-1 | 267ms | 0.12% | ● healthy |
| billing-svc | eu-west-1 | 421ms | 1.84% | ▲ degraded |
| ledger | us-east-1 | 89ms | 0.01% | ● healthy |
| ledger | eu-west-1 | 102ms | 0.02% | ● healthy |

> p95 above 400ms or error rate above 1% triggers paging.`,
      note: '工程感 dashboard：表格 + monospace 数字 + 状态符号，符合 technical posture "工程感明确，结构、状态、证据比装饰更重要"',
    },
  },
];

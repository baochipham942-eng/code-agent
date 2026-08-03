// ============================================================================
// PlanetSphere —— 品牌程序化 3D 星球（语音状态栏「星球七态」的视觉件）
//
// Canvas 程序化生成 512×256 横向无缝贴图（toDataURL 缓存，每种星球全局只生成
// 一次），CSS background-position-x 位移动画模拟自转，贴图显示宽 = 2×球径
// （--texw）。地貌特征绘制时在 x±512 各画一次保证循环无缝。地球多一层透明底
// 云层贴图（转速 = 地表 ×1.9）。方案已在 HTML 原型验证，这里是 TS 移植。
//
// 本组件是纯展示件：状态 → 星球/动效的映射在 VoiceChrome 的 VoicePlanet 里。
// ============================================================================

import React, { useEffect, useRef } from 'react';

export type PlanetKind = 'mercury' | 'earth' | 'sun' | 'jupiter';

/** 动效档位：rms=真实电平驱动辉光/微缩放；pulse=信号握手脉冲；corona=日冕脉动；
 *  sway=低频缓慢起伏；dark=暗面（去饱和）；alert=停转染红。 */
export type PlanetFx = 'rms' | 'pulse' | 'corona' | 'sway' | 'dark' | 'alert' | 'none';

export interface PlanetSphereProps {
  kind: PlanetKind;
  /** 自转周期（秒/周） */
  spinSeconds: number;
  /** 0-1，已开方的真实电平；驱动辉光 scale/opacity 与球体微缩放 */
  rms?: number;
  fx?: PlanetFx;
  /** 辉光色（状态色），rgba 字符串 */
  glowColor: string;
  /** 地球外围细轨道环 + 3px 卫星点（5.5s/周，寓意 Neo 环绕母星） */
  withOrbit?: boolean;
  /** 球径 px */
  size?: number;
  /** 可拖拽旋转（带惯性与方向）：pointer 水平拖动改自转相位，松手按最近速度
   *  惯性衰减。不做垂直俯仰（贴图高度=球径无余量，错位即露白）。
   *  仅在主视觉位开启（空态页）；reduced-motion 下自动不生效。 */
  interactive?: boolean;
}

// ============================================================================
// 贴图 painters（512×256，横向无缝）
// ============================================================================

const TEX_W = 512;
const TEX_H = 256;

type Ctx = CanvasRenderingContext2D;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 无缝关键：同一特征在 x-512 / x / x+512 各画一次，卷到边缘的形体在另一侧接上。 */
function wrapX(x: number, draw: (x: number) => void): void {
  draw(x - TEX_W);
  draw(x);
  draw(x + TEX_W);
}

function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, rot = 0): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  ctx.fill();
}

// ds-allow:start 品牌贴图调色板是程序化生貌数据（行星地貌/云/日冕色板），不属于 UI 主题色，不进 design token
const EARTH_LAND = ['#6f9450', '#7fa055', '#5d8449', '#b39b62', '#a8915c', '#c0a76e'] as const;
const JUPITER_BANDS = ['#d8b894', '#b98a5e', '#e8d8bc', '#a8713f', '#e3c9a2', '#c49a6a', '#efe2c8', '#9c6a42', '#d0ac80', '#c8ab88'] as const;

function paintEarth(ctx: Ctx): void {
  const ocean = ctx.createLinearGradient(0, 0, 0, TEX_H);
  ocean.addColorStop(0, '#0d2f6e');
  ocean.addColorStop(0.5, '#1d5cb8');
  ocean.addColorStop(1, '#0d2f6e');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // 海底深浅
  for (let i = 0; i < 42; i++) {
    ctx.fillStyle = `rgba(${randInt(18, 46)},${randInt(66, 106)},${randInt(138, 190)},.20)`;
    wrapX(rand(0, TEX_W), (x) => ellipse(ctx, x, rand(0, TEX_H), rand(22, 72), rand(10, 28), rand(-0.4, 0.4)));
  }

  // 大陆团块：9-19 个多色椭圆堆叠，28% 概率换色，再描海岸
  for (let i = 0; i < 15; i++) {
    const cx = rand(30, TEX_W - 30);
    const cy = rand(36, TEX_H - 36);
    let color = pick(EARTH_LAND);
    const blobs = randInt(9, 19);
    for (let b = 0; b < blobs; b++) {
      if (Math.random() < 0.28) color = pick(EARTH_LAND);
      ctx.fillStyle = color;
      wrapX(cx + rand(-26, 26), (x) => ellipse(ctx, x, cy + rand(-16, 16), rand(8, 22), rand(5, 13), rand(-0.6, 0.6)));
    }
    ctx.strokeStyle = 'rgba(12,32,52,.35)';
    ctx.lineWidth = 1.1;
    for (let c = 0; c < 4; c++) {
      wrapX(cx + rand(-20, 20), (x) => {
        ctx.beginPath();
        ctx.ellipse(x, cy + rand(-12, 12), rand(10, 24), rand(6, 14), rand(-0.6, 0.6), 0, Math.PI * 2);
        ctx.stroke();
      });
    }
  }

  // 岛链小点
  ctx.fillStyle = 'rgba(150,168,96,.85)';
  for (let i = 0; i < 34; i++) {
    wrapX(rand(0, TEX_W), (x) => ellipse(ctx, x, rand(20, TEX_H - 20), rand(1, 2.6), rand(0.8, 1.8)));
  }

  // 两极冰盖（32px 渐变）+ 碎冰
  for (const top of [true, false]) {
    const ice = ctx.createLinearGradient(0, top ? 0 : TEX_H, 0, top ? 32 : TEX_H - 32);
    ice.addColorStop(0, 'rgba(238,245,252,.95)');
    ice.addColorStop(1, 'rgba(238,245,252,0)');
    ctx.fillStyle = ice;
    ctx.fillRect(0, top ? 0 : TEX_H - 32, TEX_W, 32);
    ctx.fillStyle = 'rgba(238,245,252,.55)';
    for (let i = 0; i < 10; i++) {
      wrapX(rand(0, TEX_W), (x) => ellipse(ctx, x, top ? rand(24, 44) : rand(TEX_H - 44, TEX_H - 24), rand(3, 9), rand(1, 2.5)));
    }
  }
}

function paintClouds(ctx: Ctx): void {
  ctx.clearRect(0, 0, TEX_W, TEX_H);
  // 细长云带
  for (let i = 0; i < 36; i++) {
    ctx.fillStyle = `rgba(255,255,255,${rand(0.1, 0.22).toFixed(2)})`;
    wrapX(rand(0, TEX_W), (x) => ellipse(ctx, x, rand(10, TEX_H - 10), rand(22, 62), rand(2.5, 6), rand(-0.25, 0.25)));
  }
  // 蓬松云团（每团 6 个椭圆）
  for (let i = 0; i < 18; i++) {
    const cx = rand(0, TEX_W);
    const cy = rand(14, TEX_H - 14);
    for (let b = 0; b < 6; b++) {
      ctx.fillStyle = `rgba(255,255,255,${rand(0.12, 0.24).toFixed(2)})`;
      wrapX(cx + rand(-14, 14), (x) => ellipse(ctx, x, cy + rand(-6, 6), rand(6, 16), rand(3, 7), rand(-0.25, 0.25)));
    }
  }
}

function paintSun(ctx: Ctx): void {
  const base = ctx.createLinearGradient(0, 0, 0, TEX_H);
  base.addColorStop(0, '#e0801f');
  base.addColorStop(0.5, '#f7b045');
  base.addColorStop(1, '#e0801f');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // 米粒组织
  for (let i = 0; i < 3200; i++) {
    ctx.fillStyle = Math.random() < 0.5
      ? `rgba(255,${randInt(188, 238)},115,.13)`
      : 'rgba(185,88,18,.12)';
    wrapX(rand(0, TEX_W), (x) => ellipse(ctx, x, rand(0, TEX_H), rand(0.6, 2.2), rand(0.6, 2.2)));
  }

  // 对流暗胞
  ctx.fillStyle = 'rgba(168,78,14,.10)';
  for (let i = 0; i < 26; i++) {
    wrapX(rand(0, TEX_W), (x) => ellipse(ctx, x, rand(0, TEX_H), rand(14, 34), rand(9, 20), rand(-0.4, 0.4)));
  }

  // 耀斑
  for (let i = 0; i < 9; i++) {
    const fx = rand(0, TEX_W);
    const fy = rand(0, TEX_H);
    const r = rand(14, 38);
    wrapX(fx, (x) => {
      const flare = ctx.createRadialGradient(x, fy, 0, x, fy, r);
      flare.addColorStop(0, 'rgba(255,238,175,.48)');
      flare.addColorStop(1, 'rgba(255,238,175,0)');
      ctx.fillStyle = flare;
      ctx.fillRect(x - r, fy - r, r * 2, r * 2);
    });
  }
}

function paintJupiter(ctx: Ctx): void {
  ctx.fillStyle = '#c8ab88';
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // 波浪边条带：自上而下叠画，上边缘 sin 波、下边缘直伸进下一条带（被其覆盖）。
  // 波频取 2π/512 的整数倍（2/3 个周期，≈ px*.025 / px*.03），保证横向循环无缝。
  let y = -6;
  while (y < TEX_H + 6) {
    const h = rand(15, 34);
    const amp1 = rand(2, 5);
    const amp2 = rand(2, 5);
    const phase1 = rand(0, Math.PI * 2);
    const phase2 = rand(0, Math.PI * 2);
    const f1 = (Math.PI * 2 * 2) / TEX_W;
    const f2 = (Math.PI * 2 * 3) / TEX_W;
    ctx.fillStyle = pick(JUPITER_BANDS);
    ctx.beginPath();
    ctx.moveTo(0, y + amp1 * Math.sin(phase1));
    for (let x = 0; x <= TEX_W; x += 4) {
      ctx.lineTo(x, y + amp1 * Math.sin(f1 * x + phase1));
    }
    for (let x = TEX_W; x >= 0; x -= 4) {
      ctx.lineTo(x, y + h + amp2 * Math.sin(f2 * x + phase2));
    }
    ctx.closePath();
    ctx.fill();
    y += h;
  }

  // 湍流贝塞尔细丝
  ctx.lineWidth = 0.9;
  for (let i = 0; i < 300; i++) {
    ctx.strokeStyle = Math.random() < 0.5 ? 'rgba(138,92,52,.22)' : 'rgba(244,232,208,.22)';
    const sx = rand(0, TEX_W);
    const sy = rand(0, TEX_H);
    wrapX(sx, (x) => {
      ctx.beginPath();
      ctx.moveTo(x, sy);
      ctx.bezierCurveTo(x + rand(8, 20), sy + rand(-4, 4), x + rand(20, 36), sy + rand(-4, 4), x + rand(36, 56), sy + rand(-3, 3));
      ctx.stroke();
    });
  }

  // 大红斑 + 内层 + 旋涡弧
  wrapX(352, (x) => {
    ctx.fillStyle = '#b0512f';
    ellipse(ctx, x, 170, 17, 8.5);
    ctx.fillStyle = '#cd7048';
    ellipse(ctx, x, 170, 12, 5.5);
    ctx.strokeStyle = 'rgba(240,200,160,.6)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(x, 170, 7, 3, 0, Math.PI * 0.2, Math.PI * 1.4);
    ctx.stroke();
  });
}

function paintMercury(ctx: Ctx): void {
  const base = ctx.createLinearGradient(0, 0, 0, TEX_H);
  base.addColorStop(0, '#7d766c');
  base.addColorStop(0.5, '#948c80');
  base.addColorStop(1, '#6f695f');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // 噪点
  for (let i = 0; i < 2400; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(60,55,48,.16)' : 'rgba(196,188,174,.14)';
    wrapX(rand(0, TEX_W), (x) => ellipse(ctx, x, rand(0, TEX_H), rand(0.5, 1.4), rand(0.5, 1.4)));
  }

  // 环形山：暗坑 + 受光缘弧
  for (let i = 0; i < 130; i++) {
    const r = rand(2, 9);
    const ry = r * rand(0.7, 1);
    wrapX(rand(0, TEX_W), (x) => {
      const cy = rand(0, TEX_H);
      ctx.fillStyle = 'rgba(52,48,42,.5)';
      ellipse(ctx, x, cy, r, ry);
      ctx.strokeStyle = 'rgba(210,202,188,.55)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.ellipse(x, cy, r, ry, 0, Math.PI * 1.05, Math.PI * 1.75);
      ctx.stroke();
    });
  }
}
// ds-allow:end

const PAINTERS: Record<PlanetKind | 'clouds', (ctx: Ctx) => void> = {
  earth: paintEarth,
  clouds: paintClouds,
  sun: paintSun,
  jupiter: paintJupiter,
  mercury: paintMercury,
};

/** 贴图全局缓存：每种星球（含云层）全应用只生成一次。 */
const textureCache = new Map<string, string>();

function getTexture(kind: PlanetKind | 'clouds'): string {
  const cached = textureCache.get(kind);
  if (cached !== undefined) return cached;
  let url = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = TEX_W;
    canvas.height = TEX_H;
    const ctx = canvas.getContext('2d');
    // jsdom（单测）没有 canvas 2D：留空贴图，球体靠光影层兜底，不炸测试。
    if (ctx) {
      PAINTERS[kind](ctx);
      url = canvas.toDataURL('image/png');
    }
  } catch {
    url = '';
  }
  textureCache.set(kind, url);
  return url;
}

// ============================================================================
// 组件
// ============================================================================

export const PlanetSphere: React.FC<PlanetSphereProps> = ({
  kind,
  spinSeconds,
  rms = 0,
  fx = 'none',
  glowColor,
  withOrbit = false,
  size = 22,
  interactive = false,
}) => {
  const texture = getTexture(kind);
  const cloudTexture = kind === 'earth' ? getTexture('clouds') : '';
  // 云层转速 = 地表 ×1.9（周期 ÷1.9）
  const cloudSpin = spinSeconds / 1.9;
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const cloudsRef = useRef<HTMLSpanElement>(null);

  // 拖拽旋转（interactive）：pointer 水平拖动改贴图相位（沿自转方向），
  // 松手按最近速度惯性衰减。JS rAF 接管后 CSS 自转动画由 data-interactive
  // 关闭（见 PLANET_CSS 尾部）。不做垂直俯仰：贴图高度=球径无余量，错位即露白。

  useEffect(() => {
    if (!interactive) return;
    if (
      typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return; // reduced-motion：不接管，沿用内建停转
    }
    const surface = surfaceRef.current;
    if (!surface) return;
    const texw = size * 2;
    const baseSX = texw / spinSeconds;
    const baseCX = texw / cloudSpin;
    let sx = 0;
    let cx = 0;
    let velX = 0;
    let dragging = false;
    let lastX = 0;
    let lastT = 0;
    let samples: Array<{ v: number }> = [];
    let raf = 0;
    let prev = performance.now();

    // 只做水平自转：贴图横向是 360° 无缝世界图，怎么拖都不穿帮；
    // 垂直方向没有贴图余量（图高 = 球径），错位即露白，不做俯仰。
    const apply = () => {
      surface.style.backgroundPosition = `${-sx}px 0px`;
      if (cloudsRef.current) {
        cloudsRef.current.style.backgroundPosition = `${-cx}px 0px`;
      }
    };
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      if (!dragging) {
        velX *= Math.exp(-dt * 2.4);
        if (Math.abs(velX) < 1) velX = 0;
        sx += (baseSX + velX) * dt;
        cx += (baseCX + velX * 1.9) * dt;
      }
      apply();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    const onDown = (e: PointerEvent) => {
      dragging = true;
      velX = 0;
      samples = [];
      lastX = e.clientX;
      lastT = e.timeStamp;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dt = Math.max(1, e.timeStamp - lastT) / 1000;
      lastX = e.clientX;
      lastT = e.timeStamp;
      // 手指向右拖 → 贴图向右（pos.x 增大 = sx 减小），与自转方向同一坐标系
      sx -= dx;
      cx -= dx * 1.9;
      samples.push({ v: -dx / dt });
      if (samples.length > 5) samples.shift();
      apply();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      if (samples.length > 0) {
        velX = samples.reduce((acc, s) => acc + s.v, 0) / samples.length;
        velX = Math.max(-1400, Math.min(1400, velX));
      }
      samples = [];
    };

    const slot = surface.closest('.neo-planet-slot') ?? surface;
    slot.addEventListener('pointerdown', onDown as EventListener);
    window.addEventListener('pointermove', onMove as EventListener);
    window.addEventListener('pointerup', onUp as EventListener);
    window.addEventListener('pointercancel', onUp as EventListener);
    return () => {
      cancelAnimationFrame(raf);
      slot.removeEventListener('pointerdown', onDown as EventListener);
      window.removeEventListener('pointermove', onMove as EventListener);
      window.removeEventListener('pointerup', onUp as EventListener);
      window.removeEventListener('pointercancel', onUp as EventListener);
    };
  }, [interactive, size, spinSeconds, cloudSpin]);

  const slotStyle = {
    width: size,
    height: size,
    '--rms': rms.toFixed(3),
    '--texw': `${size * 2}px`,
    '--spin': `${spinSeconds}s`,
    '--cloud-spin': `${cloudSpin}s`,
    '--planet-glow': glowColor,
  } as React.CSSProperties;

  const surfaceStyle = (tex: string, fallback: boolean): React.CSSProperties => ({
    backgroundImage: tex ? `url(${tex})` : undefined,
    // 下面两处豁免（行尾标记）：--texw / --planet-glow 不是设计 token，是本组件按实例算出来的
    // 运行时值（贴图宽度 = 2×球径、辉光色 = 状态色），逐帧随 props 变，永远不可能
    // 定义在四套主题里。走 global.css 补定义等于给它们编一个假的设计决策。
    backgroundSize: `var(--texw) ${size}px`, // token-scan-allow
    // canvas 不可用（jsdom/极端环境）时的保底色，避免星球隐形（只给地表层，云层不盖底）
    backgroundColor: fallback && !tex ? 'rgba(148,163,184,.45)' : undefined,
  });

  return (
    <span
      className="neo-planet-slot"
      data-planet={kind}
      data-fx={fx}
      data-interactive={interactive ? 'true' : undefined}
      style={slotStyle}
      role="img"
      aria-hidden="true"
      data-testid="voice-planet"
    >
      <span className="neo-planet">
        <span className="neo-planet-surface" ref={surfaceRef} style={surfaceStyle(texture, true)} />
        {kind === 'earth' && <span className="neo-planet-clouds" ref={cloudsRef} style={surfaceStyle(cloudTexture, false)} />}
        <span className="neo-planet-shade" />
      </span>
      {withOrbit && (
        <span className="neo-planet-orbit">
          <span className="neo-planet-moon" />
        </span>
      )}
      <style>{PLANET_CSS}</style>
    </span>
  );
};


// ============================================================================
// 样式（同 ThoughtDisplay 的内联 <style> 先例；作用域类名 neo-planet-* 不外溢）
//
// 自转 = background-position-x 从 0 走到 -1×--texw（贴图显示宽 = 2×球径，横向
// repeat，走过一整张贴图即一周）。辉光 scale/opacity 由 CSS var --rms（真实
// 电平，开方后）驱动。prefers-reduced-motion：自转/呼吸/卫星全部关闭，保留
// 静态星球 + 颜色。
// ============================================================================

const PLANET_CSS = `
.neo-planet-slot {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
}

/* 辉光：状态色 radial，scale/opacity 由 --rms 驱动 */
.neo-planet-slot::before {
  content: '';
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  /* 同上：--planet-glow 是 style 里按状态注入的运行时色值，豁免标记在行尾 */
  background: radial-gradient(var(--planet-glow) 0%, transparent 62%); /* token-scan-allow */
  transform: scale(calc(.9 + var(--rms, 0) * .3));
  opacity: calc(.6 + var(--rms, 0) * .4);
  pointer-events: none;
}

.neo-planet {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  overflow: hidden;
}

.neo-planet-surface,
.neo-planet-clouds {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background-repeat: repeat-x;
  animation: neoPlanetSpin var(--spin, 16s) linear infinite;
}

.neo-planet-clouds {
  animation-duration: var(--cloud-spin, 8.4s);
}

/* 球体光影：左上高光 + 右下暗部 + 112deg 暗边 + inset 立体边 */
.neo-planet-shade {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    radial-gradient(circle at 31% 26%, rgba(255,255,255,.30), transparent 24%),
    radial-gradient(circle at 70% 74%, transparent 24%, rgba(0,0,0,.42) 58%, rgba(0,0,0,.82) 94%),
    linear-gradient(112deg, transparent 58%, rgba(0,0,0,.30));
  box-shadow:
    inset -3px -4px 9px rgba(0,0,0,.55),
    inset 2px 3px 6px rgba(255,255,255,.10),
    inset 0 0 0 .5px rgba(255,255,255,.06);
}

@keyframes neoPlanetSpin {
  from { background-position-x: 0; }
  to { background-position-x: calc(-1 * var(--texw, 44px)); }
}

/* rms 档（listening 地球）：辉光外，球体本身也随真实电平微缩放 */
.neo-planet-slot[data-fx='rms'] .neo-planet {
  transform: scale(calc(1 + var(--rms, 0) * .07));
}

/* pulse 档（connecting/reconnecting 水星）：脉冲式明暗 = 信号握手 */
@keyframes neoPlanetPulse {
  0%, 100% { filter: brightness(.72); }
  50% { filter: brightness(1.18); }
}
.neo-planet-slot[data-fx='pulse'] .neo-planet {
  animation: neoPlanetPulse 1.2s ease-in-out infinite;
}

/* corona 档（speaking 太阳）：日冕辉光脉动，rms（下行电平）叠在脉动上 */
@keyframes neoPlanetCorona {
  0%, 100% {
    transform: scale(calc(.92 + var(--rms, 0) * .3));
    opacity: calc(.5 + var(--rms, 0) * .4);
  }
  50% {
    transform: scale(calc(1.04 + var(--rms, 0) * .3));
    opacity: calc(.78 + var(--rms, 0) * .22);
  }
}
.neo-planet-slot[data-fx='corona']::before {
  animation: neoPlanetCorona 2.2s ease-in-out infinite;
}

/* sway 档（working 木星）：低频缓慢起伏 */
@keyframes neoPlanetSway {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}
.neo-planet-slot[data-fx='sway'] .neo-planet {
  animation: neoPlanetSway 4.6s ease-in-out infinite;
}

/* dark 档（muted 地球暗面）：去饱和、辉光熄灭（自转放慢由 --spin 传入） */
.neo-planet-slot[data-fx='dark'] .neo-planet {
  filter: saturate(.25) brightness(.55);
}
.neo-planet-slot[data-fx='dark']::before {
  opacity: 0;
}

/* alert 档（error）：当前星球停转 + 染红，无呼吸 */
.neo-planet-slot[data-fx='alert'] .neo-planet-surface,
.neo-planet-slot[data-fx='alert'] .neo-planet-clouds {
  animation-play-state: paused;
}
.neo-planet-slot[data-fx='alert'] .neo-planet {
  filter: saturate(.4) brightness(.7) sepia(.5) hue-rotate(-45deg);
}
.neo-planet-slot[data-fx='alert']::before {
  animation: none;
  transform: none;
  opacity: .5;
}

/* 轨道环 + 3px 卫星（listening 地球：Neo 环绕母星） */
.neo-planet-orbit {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,.16);
  pointer-events: none;
}
.neo-planet-moon {
  position: absolute;
  inset: 0;
  animation: neoPlanetOrbit 5.5s linear infinite;
}
.neo-planet-moon::before {
  content: '';
  position: absolute;
  top: -2px;
  left: calc(50% - 1.5px);
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(255,255,255,.85);
}
@keyframes neoPlanetOrbit {
  to { transform: rotate(360deg); }
}

/* 拖拽旋转（data-interactive）：CSS 自转交给 JS rAF 接管，指针样式提示可抓 */
.neo-planet-slot[data-interactive='true'] {
  cursor: grab;
  touch-action: none;
}
.neo-planet-slot[data-interactive='true']:active {
  cursor: grabbing;
}
.neo-planet-slot[data-interactive='true'] .neo-planet-surface,
.neo-planet-slot[data-interactive='true'] .neo-planet-clouds {
  animation: none;
}

/* reduced-motion：自转/呼吸/卫星全关，保留静态星球 + 颜色（选择器层级高于基础规则，直接覆盖） */
@media (prefers-reduced-motion: reduce) {
  .neo-planet-slot .neo-planet-surface,
  .neo-planet-slot .neo-planet-clouds,
  .neo-planet-slot .neo-planet-moon,
  .neo-planet-slot .neo-planet,
  .neo-planet-slot::before {
    animation: none;
  }
}
`;

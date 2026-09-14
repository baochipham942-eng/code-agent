import { useId } from 'react';

const N_PATH = 'M15 33.5 V14.5 L33 33.5 V14.5';
const SPARK_PATH = 'M37 6.5 L38.1 10 L41.6 11.1 L38.1 12.2 L37 15.7 L35.9 12.2 L32.4 11.1 L35.9 10 Z';

/** `mark` = 设计稿线稿（会话欢迎区 / 助手行）。`app` = 深空砖（关于页等图标场景）。 */
export function NeoBrandMark({ size = 72, variant = 'app' }: { size?: number; variant?: 'app' | 'mark' }) {
  const uid = useId().replace(/:/g, '');
  if (variant === 'mark') {
    return <svg className="brand-mark neo-mark" width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="Neo" data-variant="mark">
      <path d={N_PATH} stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d={SPARK_PATH} fill="currentColor" />
    </svg>;
  }
  const brickId = `mobile-neo-brick-${uid}`;
  const glyphId = `mobile-neo-glyph-${uid}`;
  return <svg className="brand-mark" width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="Neo" data-variant="app">
    <defs>
      <linearGradient id={brickId} x1="8" y1="8" x2="40" y2="40" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#16423f" /><stop offset="1" stopColor="#0b2422" />
      </linearGradient>
      <linearGradient id={glyphId} x1="10" y1="10" x2="38" y2="38" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#7DF9E8" /><stop offset="1" stopColor="#14B8A6" />
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="44" height="44" rx="11" fill={`url(#${brickId})`} stroke="#2dd4bf" strokeOpacity="0.3" />
    <rect x="4" y="3" width="40" height="1.5" rx="0.75" fill="#ffffff" fillOpacity="0.09" />
    <path d={N_PATH} stroke={`url(#${glyphId})`} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d={SPARK_PATH} fill="#A7F3D0" />
    <circle cx="24" cy="24" r="27" stroke="#5eead4" strokeOpacity="0.34" />
  </svg>;
}

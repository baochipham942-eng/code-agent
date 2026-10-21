/**
 * 简单 semver 比较（x.y.z 三段，缺段按 0）：负数 a<b、0 相等、正数 a>b。
 * 2026-10-15 从 ChatView.tsx 抽出：该文件贴着 max-lines=1000 硬限，
 * 抽离纯函数给挂载 BackgroundSessionPanel 腾位。
 */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

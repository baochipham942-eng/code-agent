// 视频首帧抽取：把 mp4 的第一帧画到 canvas → dataURL，作为画布视频节点的封面。
// 纯 DOM，无外部依赖；老视频节点（封面落地前生成的）没有 poster 时懒抽一张补上，
// 避免画布上黑底视频块看不出内容。

export async function captureVideoFirstFrame(videoBlobUrl: string, maxWidth = 480): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val: string | null): void => {
      if (!done) {
        done = true;
        resolve(val);
      }
    };
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    v.src = videoBlobUrl;
    v.onloadeddata = () => {
      try {
        v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
      } catch {
        finish(null);
      }
    };
    v.onseeked = () => {
      try {
        const scale = v.videoWidth > maxWidth ? maxWidth / v.videoWidth : 1;
        const w = Math.max(1, Math.round(v.videoWidth * scale));
        const h = Math.max(1, Math.round(v.videoHeight * scale));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(v, 0, 0, w, h);
        finish(c.toDataURL('image/jpeg', 0.72));
      } catch {
        finish(null);
      }
    };
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
  });
}

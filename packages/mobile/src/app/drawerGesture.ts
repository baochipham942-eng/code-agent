/**
 * 抽屉拖拽手势的纯判定（fix4-①，2026-09-14 build 35 反馈⑥：左缘起滑原来是 touchend
 * 一次性的「死手势」，松手才知道结果）。touchmove 阶段抽屉 1:1 跟手、松手按速度+位置
 * 双判据落态。抽纯函数照 sheetLibraryStatus / connectionCopy 的先例，让判定可单测。
 */

/** 起手位移超过这个值才锁横竖轴：没到之前不认任何手势，竖滑继续归滚动。 */
const AXIS_LOCK_PX = 10;
/**
 * 左缘手势区的横滑锁轴门槛比正文低（2026-09-14 反馈①的缘区语义）：从屏幕左缘起滑
 * 几乎一定是开抽屉，早 8px 跟手；竖滑仍在 |dy|>|dx| 时让位，缘区不抢滚动。
 */
const EDGE_AXIS_LOCK_PX = 2;
/** 左缘手势区宽度（沿 fix3 的 EDGE_GESTURE_START_X 语义）。 */
export const EDGE_GESTURE_START_X = 28;
/** 松手速度判据：|v| 超过它就按方向直接开/关，不看拖到哪（快 flick 不过半也要开）。 */
const FLICK_VELOCITY_PX_PER_MS = 0.5;
/** 松手回弹动画时长；commit 定时器比它略长，保证动画播完再卸载/清 transform。 */
export const DRAWER_SETTLE_MS = 260;
/**
 * 锁轴拖拽后吞 click 的窗口（fix5-②，2026-09-15 build 36 反馈⑦）：拖过 AXIS_LOCK_PX 松手时
 * 浏览器仍会合成 click——起手与落点在同一条会话行上时它就落在会话按钮上，「拖一半松手」
 * 变成点中会话。比 260ms 回弹略宽，覆盖 Android 较慢的 click 合成；窗口过了自动恢复点按。
 */
export const CLICK_SWALLOW_MS = 300;

/**
 * 这次 touchend 之后的 click 要不要吞：只有**锁过轴**的拖拽才吞（拖动成立，click 必是拖拽
 * 的副产品）；没锁轴的轻点 axis=null，click 就是用户本意，照常放行。竖向锁轴在 gestureMove
 * 里已让位滚动、到不了松手这里，列出只为类型完整。
 */
export function shouldSwallowClick(axis: 'horizontal' | 'vertical' | null): boolean {
  return axis === 'horizontal';
}

/** 抽屉宽度与 styles.css 的 .drawer 同源：min(86vw, 360px)。 */
export function drawerWidthPx(viewport: number): number {
  return Math.min(viewport * 0.86, 360);
}

/**
 * 起手锁轴：横竖分明才认。竖滑返回 'vertical' 让位给滚动；横滑返回 'horizontal' 开始
 * 跟手拖拽。缘区起滑（edgeStart）横滑门槛降为 EDGE_AXIS_LOCK_PX——边缘起滑优先认抽屉。
 */
export function gestureAxis(dx: number, dy: number, edgeStart = false): 'horizontal' | 'vertical' | null {
  const horizontalLock = edgeStart ? EDGE_AXIS_LOCK_PX : AXIS_LOCK_PX;
  if (Math.abs(dx) >= horizontalLock && Math.abs(dx) >= Math.abs(dy)) return 'horizontal';
  if (Math.abs(dy) >= AXIS_LOCK_PX && Math.abs(dy) > Math.abs(dx)) return 'vertical';
  return null;
}

/**
 * 松手落哪个态：速度优先（|v|>0.5px/ms 按方向直接开/关，不看位置），慢拖看位移过半。
 * 「回弹」= 目标态就是当前态（open 拖了但没过半仍回 open），由调用方带 transition 落过去。
 */
export function drawerPanState(dx: number, vx: number, open: boolean, width: number): 'open' | 'close' {
  if (Math.abs(vx) > FLICK_VELOCITY_PX_PER_MS) return vx > 0 ? 'open' : 'close';
  return open ? (dx < -width / 2 ? 'close' : 'open') : (dx > width / 2 ? 'open' : 'close');
}

/** 拖拽位移 → 抽屉 translateX（px，负值）：关→开从 -width 拖到 0，开→关 clamp 在 [-width,0]。 */
export function drawerPanOffset(dx: number, width: number, open: boolean): number {
  const offset = open ? dx : dx - width;
  return Math.min(0, Math.max(-width, offset));
}

// 图标契约真源是设计稿 design.html 的 ICONS 映射（stroke-width 1.7、圆头圆角）；
// 菜单两线来自设计稿导航条内联 SVG。新增图标先从设计稿抄路径，不要自绘。
const PATHS = {
  menu: 'M4 8h16M4 15h10',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  back: 'm15 18-6-6 6-6',
  chevron: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  settings: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM10 2h4l1 3 3 2 3 1v4l-2 3-1 3-3 1-1 3h-4l-1-3-3-1-2-3-2-3V8l3-1 3-2Z',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Zm-3 6v1a6 6 0 0 0 12 0v-1M12 18v4M9 22h6',
  stop: 'M7 7h10v10H7z',
  attach: 'M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5',
} as const;

export function AppIcon({ name }: { name: keyof typeof PATHS }) {
  return <svg className="app-icon" data-name={name} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name]} /></svg>;
}

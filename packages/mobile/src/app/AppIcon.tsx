// 图标契约真源是设计稿 design.html 的 ICONS 映射（stroke-width 1.7、圆头圆角）与 icon() 的渲染分支；
// 菜单两线来自设计稿导航条内联 SVG。「更多」是三个 r=1.7 实心圆，照 icon() 用 fill 画、不描边
// （N-MOBILE-HEADER-ICON-STYLE，爸 09-17：零长度描边点在真机上又小又虚）。新增图标先从设计稿抄路径，不要自绘。
const PATHS = {
  menu: 'M4 8h16M4 15h10',
  more: 'M3.3 12a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0M10.3 12a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0M17.3 12a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  back: 'm15 18-6-6 6-6',
  chevron: 'm9 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  settings: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM10 2h4l1 3 3 2 3 1v4l-2 3-1 3-3 1-1 3h-4l-1-3-3-1-2-3-2-3V8l3-1 3-2Z',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Zm-3 6v1a6 6 0 0 0 12 0v-1M12 18v4M9 22h6',
  stop: 'M7 7h10v10H7z',
  attach: 'M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h6',
  image: 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M8 7h.01',
  folder: 'M3 5h6l2 2h10v13H3z',
  camera: 'M3 7h4l2-3h6l2 3h4v14H3zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
} as const;

export function AppIcon({ name }: { name: keyof typeof PATHS | 'profile' }) {
  // 通用头像图标（未登录个人卡用，N-COMPANION-RELAY-ACCOUNT-LOGIN-V3）：圆+身形，design.html
  // icon() 的 profile 分支是双元素（circle+path），不是单 path，走独立分支渲染。
  if (name === 'profile') return <svg className="app-icon" data-name={name} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></svg>;
  if (name === 'more') return <svg className="app-icon" data-name={name} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d={PATHS[name]} /></svg>;
  return <svg className="app-icon" data-name={name} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name]} /></svg>;
}

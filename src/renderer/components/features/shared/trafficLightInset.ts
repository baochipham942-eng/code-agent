// ============================================================================
// trafficLightInset —— macOS 红绿灯让位的唯一真源（padding 制度）。
// 原生标题栏已撤（titleBarStyle=Overlay），侧栏一收起，右侧顶栏/inline 二级页页头
// 就成了窗口左上角那块，darwin 下要让开灯区：灯摆在 x16..75.5（横纵都由
// traffic_lights.rs 摆，见那里的常量），再留呼吸位 ⇒ 92。
// ⚠️ 灯的横向位置一改，这个数就要跟着改——它不在 CSS 节奏里，不会自己动。
// 同源消费方：TitleBar 展开按钮、FullScreenPageHeader bar 页头（两按钮左缘对齐，
// 批P 审美关 2026-07-30，禁止各页面各自特判）。
// ============================================================================
import { getCurrentKeybindingPlatform } from '@shared/keybindings/defaults';

export const COLLAPSED_TRAFFIC_LIGHT_INSET = getCurrentKeybindingPlatform() === 'darwin' ? 'pl-[92px]' : '';

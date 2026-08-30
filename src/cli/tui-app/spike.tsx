/**
 * Step 0 spike 入口：验证 Ink 能否被 esbuild 打成单文件 cjs 并正常渲染。
 *
 * cjs bundle 不支持 top-level await，且 ink 的模块顶层会同步读取 Yoga 枚举，
 * 所以这里先等 yoga wasm 就绪，再动态 import 应用主体（esbuild 会把动态 import
 * 转成延迟求值，ink 的模块初始化推迟到 wasm 就绪之后）。
 */
import { yogaReady } from './yogaCjsShim';

void yogaReady.then(() => import('./spikeMain')).then(({ start }) => start());

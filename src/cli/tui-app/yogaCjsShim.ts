/**
 * yoga-layout 的 CJS 打包垫片（Step 0 spike 验证后转正，Ink chat 共用）。
 *
 * 背景：yoga-layout@3 的默认入口用 top-level await 加载 wasm（base64 内嵌，
 * 无外部文件依赖），esbuild 打 cjs 不支持 TLA 会直接报错。这里绕过官方入口，
 * 手动组装 emscripten loader + wrapAssembly：
 * - 模块加载时立即启动异步 wasm 实例化（不阻塞 bundle 初始化）；
 * - 默认导出是一个 Proxy，属性访问转发到实例化完成的 Yoga；
 * - 入口在 render 之前 `await yogaReady`，保证 Proxy 被使用时 wasm 已就绪。
 *
 * 用于 dist/cli/index.cjs（Ink chat）与 dist/cli/spike.cjs 两个 target，不影响其他构建产物。
 */
// @ts-expect-error emscripten 生成的 loader 无类型声明
import loadYoga from 'yoga-layout/dist/binaries/yoga-wasm-base64-esm.js';
// @ts-expect-error yoga 内部模块，无独立类型入口
import wrapAssembly from 'yoga-layout/dist/src/wrapAssembly.js';

type YogaInstance = typeof import('yoga-layout').default;

const loadYogaImpl = loadYoga as () => Promise<unknown>;
const wrapAssemblyImpl = wrapAssembly as (assembly: unknown) => YogaInstance;

let impl: YogaInstance | undefined;

export const yogaReady: Promise<void> = loadYogaImpl().then((assembly) => {
  impl = wrapAssemblyImpl(assembly);
});

const Yoga = new Proxy({} as YogaInstance, {
  get(_target, prop, receiver) {
    if (!impl) {
      throw new Error('yoga-layout wasm 尚未就绪：render 前请先 await yogaReady');
    }
    return Reflect.get(impl as object, prop, receiver) as unknown;
  },
});

export default Yoga;

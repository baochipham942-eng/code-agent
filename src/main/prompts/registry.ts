// ============================================================================
// Prompt Registry - 提示词注册中心 + 用户 override 持久化
// ============================================================================
// 用法：
//   export const IDENTITY = applyOverride(
//     { id: 'identity', category: 'Core', name: 'Identity' },
//     `... 默认提示词文本 ...`,
//   );
//
// 模块加载时同步读取 ~/.code-agent/prompts-overrides/<id>.md，命中则返回 override，
// 否则返回 default。注册同时把元数据 + 默认文本登记到中央表，供 IPC 列出/查看/重置。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CONFIG_DIR_NEW } from '../config/configPaths';

export interface PromptDescriptor {
  id: string;
  category: string;
  name: string;
  description?: string;
}

export interface PromptDetail extends PromptDescriptor {
  defaultText: string;
  override: string | null;
  overridden: boolean;
}

const overrides = new Map<string, string>();
const descriptors = new Map<string, PromptDescriptor & { defaultText: string }>();

let initialized = false;
let cachedOverrideDir: string | null = null;

function getOverrideDir(): string {
  if (!cachedOverrideDir) {
    cachedOverrideDir = path.join(os.homedir(), CONFIG_DIR_NEW, 'prompts-overrides');
  }
  return cachedOverrideDir;
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  const dir = getOverrideDir();
  try {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const id = file.slice(0, -3);
      try {
        overrides.set(id, fs.readFileSync(path.join(dir, file), 'utf-8'));
      } catch {
        /* ignore individual file failures — fall back to default */
      }
    }
  } catch {
    /* dir read failed — treat as no overrides */
  }
}

/**
 * 构造一个看起来是 string 的"实时字符串"——
 *
 * 模板字符串拼接、`+` 拼接、`Array.join`、`String(x)`、`.startsWith()` 等会通过
 * Symbol.toPrimitive / valueOf / property forward 拿到当前最新的 override 文本。
 * 这样 `export const FOO = applyOverride(...)` 在用户保存 override 后无需重启
 * 也能反映新值。
 *
 * 已知边角情况：
 * - `typeof FOO === 'string'` 会得到 `'object'`（Proxy 不是原始 string）。
 * - `FOO === '某字面量'` 比较的是 reference，永不为 true。
 *   prompt 文本 consumer 几乎不会做这两类检查，可接受。
 */
function makeLivePrompt(id: string, defaultText: string): string {
  const live = (): string => overrides.get(id) ?? defaultText;

  const handler: ProxyHandler<string> = {
    get(_target, prop) {
      const text = live();
      if (prop === Symbol.toPrimitive) return (_hint: string) => text;
      if (prop === 'valueOf' || prop === 'toString') return () => text;
      if (prop === 'length') return text.length;
      const value = (text as unknown as Record<PropertyKey, unknown>)[prop as PropertyKey];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(text)
        : value;
    },
    has(_target, prop) {
      return prop in (live() as unknown as object);
    },
  };

  return new Proxy(new String(defaultText), handler) as unknown as string;
}

/**
 * 在 prompt 模块加载时调用：登记元数据 + 默认文本，返回一个"实时"字符串
 * （Proxy 包装），override 改了之后下一次拼接 system prompt 自动用新值。
 */
export function applyOverride(meta: PromptDescriptor, defaultText: string): string {
  ensureInitialized();
  if (descriptors.has(meta.id)) {
    throw new Error(`Duplicate prompt id: ${meta.id}`);
  }
  descriptors.set(meta.id, { ...meta, defaultText });
  return makeLivePrompt(meta.id, defaultText);
}

/**
 * 创建一个"动态拼接"字符串：每次被 String() / 模板字符串求值时都调 builder()
 * 重新拼接。用于把多个 applyOverride const 组合成更大的 prompt 常量（例如
 * `IDENTITY_PROMPT = dynamic(() => `${IDENTITY}\n\n${CONCISENESS_RULES}\n...`)`），
 * 让组合版本也实时跟随子项 override 变化。
 */
export function dynamic(build: () => string): string {
  const handler: ProxyHandler<string> = {
    get(_target, prop) {
      const text = build();
      if (prop === Symbol.toPrimitive) return (_h: string) => text;
      if (prop === 'valueOf' || prop === 'toString') return () => text;
      if (prop === 'length') return text.length;
      const value = (text as unknown as Record<PropertyKey, unknown>)[prop as PropertyKey];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(text)
        : value;
    },
    has(_target, prop) {
      return prop in (build() as unknown as object);
    },
  };
  return new Proxy(new String(''), handler) as unknown as string;
}

/**
 * 列出所有已注册的 prompt 元数据 + override 状态（不含 defaultText 全文，节省传输量）。
 */
export function listPrompts(): PromptDescriptor[] & { overridden?: boolean }[] {
  return Array.from(descriptors.values())
    .map(({ id, category, name, description }) => ({
      id,
      category,
      name,
      description,
      overridden: overrides.has(id),
    }))
    .sort((a, b) =>
      a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
    ) as PromptDescriptor[] & { overridden?: boolean }[];
}

/**
 * 取单个 prompt 详情：默认文本 + 当前 override（如有）。
 */
export function getPromptDetail(id: string): PromptDetail | null {
  const d = descriptors.get(id);
  if (!d) return null;
  const override = overrides.get(id) ?? null;
  return {
    id: d.id,
    category: d.category,
    name: d.name,
    description: d.description,
    defaultText: d.defaultText,
    override,
    overridden: override !== null,
  };
}

/**
 * 写入 override 到文件 + 更新内存 map。下一次任何 consumer 触碰对应 prompt
 * 常量（applyOverride 返回的 Proxy）都会拿到最新文本。
 */
export function setPromptOverride(id: string, text: string): void {
  if (!descriptors.has(id)) throw new Error(`Unknown prompt id: ${id}`);
  const dir = getOverrideDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), text, 'utf-8');
  overrides.set(id, text);
}

/**
 * 删除 override：恢复使用默认文本。
 */
export function resetPromptOverride(id: string): void {
  if (!descriptors.has(id)) throw new Error(`Unknown prompt id: ${id}`);
  const dir = getOverrideDir();
  const file = path.join(dir, `${id}.md`);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  overrides.delete(id);
}

/**
 * 给消费方用的实时查询接口：每次都查 override map，让 override 立即生效。
 * 与 applyOverride 不同 —— applyOverride 在模块加载时取一次值固化下来。
 */
export function lookupPromptText(id: string): string | null {
  const d = descriptors.get(id);
  if (!d) return null;
  return overrides.get(id) ?? d.defaultText;
}

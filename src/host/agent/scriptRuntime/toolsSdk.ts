// ============================================================================
// toolsSdk —— 工具目录 → 模型可读的 TypeScript SDK 投影（PTC / Code Mode）
//
// 模型要写出 `await tools.Read({ path })`，前提是它先看过这个签名。本模块把工具目录
// 渲染成一段 TS 声明喂给模型，形态对齐 DeepSeek Harness Code Mode 的 renderToolsSdk。
//
// 两条硬性质，都不是风格问题：
//   1. **确定性**：工具按名字字典序输出，同一份工具集渲染两次必须逐字节相同。
//      呈现档在会话组合时定死、整个会话不变，靠的就是请求前缀稳定 → KV cache 有效；
//      渲染顺序抖一下，缓存就全废。
//   2. **只覆盖受支持子集**：类型转换的覆盖面恰好等于 `assertSupportedJsonSchema`
//      允许的集合（object/string/number/boolean/array）。多一分是没人能触发的死代码，
//      少一分是静默产出错类型——遇到集合外的形状**直接抛**，不静默降级成 unknown。
// ============================================================================

import type { JSONSchema, JSONSchemaProperty } from '../../../shared/contract';

/** 渲染 SDK 只需要这四样；用结构类型而非 ToolDefinition，避免把渲染层绑死在工具契约上。 */
export interface SdkToolProjection {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
}

const INDENT = '  ';

function pad(depth: number): string {
  return INDENT.repeat(depth);
}

/** 合法标识符直接用，其余加引号——工具名里出现 `-` / `.` 时脚本得写 tools["my-tool"]()。 */
function renderKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** 工具 description 原样变成 JSDoc 挂在成员上——它是模型选工具的主要依据，不能在投影时丢掉。 */
function docLines(description: string, depth: number): string[] {
  const text = description.trim();
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length === 1) return [`${pad(depth)}/** ${lines[0]} */`];
  return [
    `${pad(depth)}/**`,
    ...lines.map((line) => `${pad(depth)} * ${line}`),
    `${pad(depth)} */`,
  ];
}

/**
 * JSON Schema → TS 类型。**两套口径，别合并**：
 *
 * - `strict`（产出侧）：覆盖面恰好等于 `assertSupportedJsonSchema` 允许的集合。
 *   注册期已拦过一道，能走到这里说明两边口径漂了——静默产出宽类型比报错更坏，所以抛。
 * - `lenient`（入参侧）：**inputSchema 不受那道校验约束**，是既有的、真实世界的工具参数
 *   形状（自由对象、enum、integer、oneOf…）。这里降级成 `unknown` 而不是抛，
 *   否则一个工具的历史 schema 就能让整份 SDK 生不出来。
 *
 * 降级必须留痕：降级处在产物里带 `/* 未声明具体形状 *\/` 注释，模型和人都看得见，
 * 不是悄悄换个宽类型了事。
 *
 * 这条区分是拿真实工具目录跑出来的——`TaskManager.inputSchema.properties.metadata`
 * 就是个没有 properties 的自由对象，用产出侧的严格口径去渲染它会直接抛。
 */
function jsonSchemaToTs(
  schema: JSONSchema | JSONSchemaProperty,
  depth: number,
  path: string,
  strict: boolean,
): string {
  const degrade = (reason: string): string => {
    if (strict) throw new Error(`${path}: ${reason}`);
    return 'unknown /* 未声明具体形状 */';
  };
  // enum 优先于 type：它是对模型最有价值的一类信息（这个参数只能取哪几个值），
  // 渲染成字面量联合而不是退回 string。真实工具目录里 string+enum 有 99 处，
  // 当成普通 string 等于把这 99 处的取值约束全丢了。
  const enumValues = (schema as { enum?: unknown }).enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.map((v) => JSON.stringify(v)).join(' | ');
  }

  const type = (schema as { type?: unknown }).type;

  // type 可以是数组（如 ["string","number"]）——逐个映射后取联合。
  if (Array.isArray(type)) {
    if (type.length === 0) return degrade('type 是空数组');
    // Array.isArray 把 unknown 收窄成 any[]，显式转回 unknown[] 免得 t 是 any。
    const parts = (type as unknown[]).map((t) =>
      jsonSchemaToTs({ ...(schema as object), type: t } as JSONSchemaProperty, depth, path, strict));
    return [...new Set(parts)].join(' | ');
  }

  switch (type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    // integer 不在产出侧的受支持集合里，但入参侧真实存在（行号、条数这类），
    // 且它在 TS 里就是 number——映射掉，不该降级成 unknown。
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const items = (schema as { items?: JSONSchemaProperty }).items;
      // 自由数组（有 type 没 items）在入参侧同样常见（operations/datasets/steps 这类）。
      // 降成 unknown[] 而不是 unknown——至少保住「这是个数组」，模型才知道要传数组。
      if (!items) {
        return strict
          ? degrade('array 缺少 items')
          : 'unknown[] /* 未声明元素形状 */';
      }
      const inner = jsonSchemaToTs(items, depth, `${path}.items`, strict);
      // 对象字面量后面直接跟 [] 在 TS 里合法，但可读性差；括起来更清楚。
      return inner.startsWith('{') ? `Array<${inner}>` : `${inner}[]`;
    }
    case 'object': {
      const properties = (schema as { properties?: Record<string, JSONSchemaProperty> }).properties;
      // 自由对象（有 type 没 properties）在入参侧是常见的既有形状，不是错误。
      if (!properties) {
        return strict
          ? degrade('object 缺少 properties')
          : 'Record<string, unknown> /* 未声明具体形状 */';
      }
      const required = new Set(
        Array.isArray((schema as { required?: unknown }).required)
          ? ((schema as { required: string[] }).required)
          : [],
      );
      const keys = Object.keys(properties).sort();
      if (keys.length === 0) return '{}';
      const members = keys.map((key) => {
        const optional = required.has(key) ? '' : '?';
        const rendered = jsonSchemaToTs(properties[key], depth + 1, `${path}.properties.${key}`, strict);
        return `${pad(depth + 1)}${renderKey(key)}${optional}: ${rendered};`;
      });
      return `{\n${members.join('\n')}\n${pad(depth)}}`;
    }
    default:
      return degrade(`不受支持的 schema type ${JSON.stringify(type)}`);
  }
}

/**
 * 给模型的固定使用说明。跟在它后面的是生成的声明块。
 * 最后一条是本机制的关键约定，必须写给模型看而不是靠系统悄悄裁剪。
 */
export const SDK_INSTRUCTIONS = `## 在脚本里调用工具

- 用 \`await tools.名字(参数)\` 调用；名字含连字符等特殊字符时写 \`tools["my-tool"](参数)\`。
  每次调用返回该工具的产出值（下方 ToolOutputMap 声明了具体形状）。
- 参数必须是**无损 JSON**：不能带 undefined 字段、BigInt、NaN/Infinity、-0、函数、
  Date/Map/Set、循环引用。违反会被逐次拒绝并告诉你是哪个字段。
- 调用失败会抛 \`ToolCallError\`（带 \`toolName\` 和可读 \`message\`），
  用 \`try/catch\` 接住就能继续跑，不会中断整个程序。
- 互不依赖的只读调用可以用 \`Promise.all\` 并发；有依赖关系的用 \`await\` 排序。
- 用 \`return\` 返回结果，或用 \`console.log\` 打印。**只有你打印或返回的内容会回到对话里**——
  中间的工具产出留在运行环境中，所以请自己提取需要的部分。

可用的工具：`;

/**
 * 渲染完整 SDK 段落（使用说明 + TS 声明块）。
 *
 * 确定性：按名字字典序输出，同一份工具集渲染两次逐字节相同。调用方负责排除传输工具
 * 自身（模型是通过它进来的，不该在目录里看到自己）。
 */
export function renderToolsSdk(tools: readonly SdkToolProjection[]): string {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const argsMembers: string[] = [];
  const outputMembers: string[] = [];
  for (const tool of sorted) {
    argsMembers.push(...docLines(tool.description, 1));
    // 入参走 lenient（真实世界形状），产出走 strict（受注册期校验保护）。
    argsMembers.push(
      `${pad(1)}${renderKey(tool.name)}: ${jsonSchemaToTs(tool.inputSchema, 1, `${tool.name}.inputSchema`, false)};`,
    );
    outputMembers.push(
      `${pad(1)}${renderKey(tool.name)}: ${jsonSchemaToTs(tool.outputSchema, 1, `${tool.name}.outputSchema`, true)};`,
    );
  }

  const argsMap = `interface ToolArgsMap {${argsMembers.length ? `\n${argsMembers.join('\n')}\n` : ''}}`;
  const outputMap = `interface ToolOutputMap {${outputMembers.length ? `\n${outputMembers.join('\n')}\n` : ''}}`;

  const declaration = [
    argsMap,
    outputMap,
    'type ToolName = keyof ToolOutputMap',
    [
      'declare class ToolCallError extends Error {',
      `${INDENT}readonly name: "ToolCallError";`,
      `${INDENT}readonly toolName: ToolName;`,
      '}',
    ].join('\n'),
    [
      'declare const tools: {',
      `${INDENT}[K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;`,
      '}',
    ].join('\n'),
  ].join('\n\n');

  return `${SDK_INSTRUCTIONS}\n\n\`\`\`ts\n${declaration}\n\`\`\``;
}

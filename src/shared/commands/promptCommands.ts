// ============================================================================
// Prompt command 协议层 — 纯逻辑（roadmap 2.2）
// ============================================================================
// Adapted from MiMoCode (XiaomiMiMo/MiMo-Code, MIT license) — command/index.ts
// 的 Command Info（name/description/agent/model/subtask/template/hints）与
// $1/$ARGUMENTS 模板协议；解析与展开按 Neo 约定重写。
//
// 与 commandRegistry.ts（handler 型命令，GUI/CLI 本地执行）的分工：
// prompt command 是"模板型命令"——展开成 prompt 交给模型，可被文件
// （.code-agent/commands/<name>.md）与 MCP prompts 定义，是 distill 自进化
// 产出物的天然载体。
// ============================================================================

export type PromptCommandSource = 'file' | 'mcp';

export interface PromptCommandInfo {
  name: string;
  description?: string;
  /** 路由到指定 agent（对接 AppServiceRunOptions.agentOverrideId） */
  agent?: string;
  /** 模型覆盖（当前仅解析保留；消息级模型路由待接入，见 roadmap 2.2 备注） */
  model?: string;
  /** 以子任务（subagent）方式运行；当前仅解析保留 */
  subtask?: boolean;
  source: PromptCommandSource;
  /** file 命令为模板本体；mcp 命令为空串（模板在 resolve 时远程获取） */
  template: string;
  /** 参数提示：['$1', '$2', '$ARGUMENTS'] */
  hints: string[];
  /** file 命令的来源作用域 */
  scope?: 'user' | 'project';
  /** mcp 命令的来源 server */
  serverName?: string;
}

export interface SlashInvocation {
  name: string;
  args: string;
}

export interface PromptCommandResolution {
  name: string;
  prompt: string;
  source: PromptCommandSource;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

/**
 * 解析 "/name args..." 调用。非命令形态返回 null。
 * name 限 [A-Za-z0-9_-]+；args 保留原始形态（含换行），仅去掉与 name 的分隔符。
 */
export function parseSlashInvocation(content: string): SlashInvocation | null {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(content);
  if (!match) {
    return null;
  }
  return { name: match[1], args: (match[2] ?? '').trim() };
}

/** 从模板提取参数提示：去重排序的 $N + 末尾的 $ARGUMENTS */
export function computeHints(template: string): string[] {
  const result: string[] = [];
  const numbered = template.match(/\$\d+/g);
  if (numbered) {
    const unique = [...new Set(numbered)];
    unique.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    result.push(...unique);
  }
  if (template.includes('$ARGUMENTS')) {
    result.push('$ARGUMENTS');
  }
  return result;
}

/** 按 shell 习惯切词：空白分隔，双引号包裹的算一个 token（引号剥除） */
export function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(args)) !== null) {
    tokens.push(match[1] ?? match[2]);
  }
  return tokens;
}

/**
 * 模板展开：$N → 第 N 个 token（缺省空串）；$ARGUMENTS → 原始参数串。
 * 模板无占位符但带参数时，参数附加在末尾（不丢用户输入）。
 */
export function expandPromptTemplate(template: string, args: string): string {
  const hints = computeHints(template);
  if (hints.length === 0) {
    return args ? `${template}\n\nAdditional input:\n${args}` : template;
  }

  const tokens = tokenizeArgs(args);
  // 单遍替换：只展开模板自带的占位符，用户参数里的 $1/$ARGUMENTS 字面量
  // 不会被二次展开（Codex R1 MED）
  return template.replace(/\$(ARGUMENTS|\d+)/g, (_whole, key: string) =>
    key === 'ARGUMENTS' ? args : tokens[Number(key) - 1] ?? '');
}

/**
 * 解析 .code-agent/commands/<name>.md：可选 frontmatter
 * （description/agent/model/subtask）+ 模板正文。
 * frontmatter 用简单 key: value 解析（与 agentMdLoader 同风格，不引依赖）。
 */
export function parsePromptCommandFile(name: string, raw: string): PromptCommandInfo {
  let body = raw;
  let description: string | undefined;
  let agent: string | undefined;
  let model: string | undefined;
  let subtask: boolean | undefined;

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (fmMatch) {
    body = fmMatch[2];
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2].trim().replace(/^["']|["']$/g, '');
      if (key === 'description') description = value;
      else if (key === 'agent') agent = value;
      else if (key === 'model') model = value;
      else if (key === 'subtask') subtask = value === 'true';
    }
  }

  const template = body.trim();
  return {
    name,
    description,
    agent,
    model,
    subtask,
    source: 'file',
    template,
    hints: computeHints(template),
  };
}

// ============================================================================
// P0-5 POC: Tool Schema Registry 验证
//
// 验收标准：
// 1. registry.register 仅存 schema + loader，不触发 tool 模块 import
// 2. registry.getSchemasForMode 按 readOnly/category/deny 过滤并字典序稳定
// 3. registry.resolve 首次调用才触发 dynamic import 和 createHandler
// 4. 3 个 POC tool 都能被正确调用，ctx / canUseTool / onProgress 注入到位
// 5. canUseTool 拒绝场景：tool 返回 PERMISSION_DENIED
// 6. WebSearch 无 API key 场景：tool 返回 API_KEY_MISSING
// 7. Bash 超时：tool 正确 kill 子进程并返回 TIMEOUT
// 8. ReadPoc 文件缓存：第二次读取命中 cache
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ToolRegistry, registerPocTools } from '../../../src/main/tools/registry';
import type {
  ToolContext,
  CanUseToolFn,
  ToolProgress,
  ToolResult,
  FileReadCache,
  Logger,
} from '../../../src/main/protocol/tools';

// ----- helpers -----

function makeLogger(sink: string[] = []): Logger {
  return {
    debug: (msg) => sink.push(`[debug] ${msg}`),
    info: (msg) => sink.push(`[info] ${msg}`),
    warn: (msg) => sink.push(`[warn] ${msg}`),
    error: (msg) => sink.push(`[error] ${msg}`),
  };
}

function makeFileCache(): FileReadCache {
  const store = new Map<string, { content: string; mtimeMs: number }>();
  return {
    get: (p) => store.get(p),
    set: (p, content, mtimeMs) => {
      store.set(p, { content, mtimeMs });
    },
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const controller = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: controller.signal,
    logger: makeLogger(),
    emit: () => void 0,
    fileCache: makeFileCache(),
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked by test' });

// ----- tests -----

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('register 只存 schema，不触发 loader', () => {
    const loader = vi.fn().mockResolvedValue({ schema: { name: 'X' }, createHandler: () => ({}) });
    registry.register(
      {
        name: 'X',
        description: '',
        inputSchema: { type: 'object', properties: {}, required: [] },
        category: 'fs',
        permissionLevel: 'read',
      },
      loader,
    );
    expect(registry.has('X')).toBe(true);
    expect(loader).not.toHaveBeenCalled();
  });

  it('getSchemasForMode 按 readOnly / category / deny 过滤', () => {
    registerPocTools(registry);
    const schemas = registry.getSchemasForMode({ readOnly: true });
    const names = schemas.map((s) => s.name);
    // ReadPoc 和 WebSearchPoc 是 readOnly，BashPoc 不是
    expect(names).toContain('ReadPoc');
    expect(names).toContain('WebSearchPoc');
    expect(names).not.toContain('BashPoc');
    // 字典序稳定
    expect([...names].sort()).toEqual(names);
  });

  it('getSchemasForMode deny 名单过滤', () => {
    registerPocTools(registry);
    const schemas = registry.getSchemasForMode({ deny: new Set(['BashPoc']) });
    expect(schemas.find((s) => s.name === 'BashPoc')).toBeUndefined();
  });

  it('resolve 首次触发 createHandler，第二次走缓存', async () => {
    registerPocTools(registry);
    const h1 = await registry.resolve('ReadPoc');
    const h2 = await registry.resolve('ReadPoc');
    expect(h1).toBe(h2); // 同一 instance
  });

  it('resolve 并发调用合并成同一次 load', async () => {
    registerPocTools(registry);
    const [h1, h2, h3] = await Promise.all([
      registry.resolve('WebSearchPoc'),
      registry.resolve('WebSearchPoc'),
      registry.resolve('WebSearchPoc'),
    ]);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it('resolve 未注册 tool 抛错', async () => {
    await expect(registry.resolve('NotExist')).rejects.toThrow(/not registered/);
  });
});

describe('ReadPoc handler', () => {
  let registry: ToolRegistry;
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    registry = new ToolRegistry();
    registerPocTools(registry);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readpoc-'));
    tmpFile = path.join(tmpDir, 'sample.txt');
    await fs.writeFile(tmpFile, 'line 1\nline 2\nline 3\nline 4\nline 5\n');
  });

  it('读取全量文件', async () => {
    const handler = await registry.resolve('ReadPoc');
    const result = (await handler.execute(
      { file_path: tmpFile },
      makeCtx(),
      allowAll,
    )) as ToolResult<{ content: string; lineCount: number; truncated: boolean; fromCache: boolean }>;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.content).toContain('line 1');
      expect(result.output.content).toContain('line 5');
      expect(result.output.fromCache).toBe(false);
    }
  });

  it('offset + limit 正确切片', async () => {
    const handler = await registry.resolve('ReadPoc');
    const result = (await handler.execute(
      { file_path: tmpFile, offset: 2, limit: 2 },
      makeCtx(),
      allowAll,
    )) as ToolResult<{ content: string }>;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.content).toBe('line 2\nline 3');
    }
  });

  it('文件缓存：第二次命中', async () => {
    const handler = await registry.resolve('ReadPoc');
    const cache = makeFileCache();
    const ctx = makeCtx({ fileCache: cache });

    const r1 = (await handler.execute({ file_path: tmpFile }, ctx, allowAll)) as ToolResult<{
      fromCache: boolean;
    }>;
    const r2 = (await handler.execute({ file_path: tmpFile }, ctx, allowAll)) as ToolResult<{
      fromCache: boolean;
    }>;

    expect(r1.ok && r1.output.fromCache).toBe(false);
    expect(r2.ok && r2.output.fromCache).toBe(true);
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await registry.resolve('ReadPoc');
    const result = await handler.execute({ file_path: tmpFile }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('onProgress 被调用', async () => {
    const handler = await registry.resolve('ReadPoc');
    const stages: ToolProgress['stage'][] = [];
    await handler.execute({ file_path: tmpFile }, makeCtx(), allowAll, (p) => {
      stages.push(p.stage);
    });
    expect(stages).toContain('starting');
    expect(stages).toContain('completing');
  });
});

describe('BashPoc handler', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerPocTools(registry);
  });

  it('基本执行', async () => {
    const handler = await registry.resolve('BashPoc');
    const result = (await handler.execute(
      { command: 'echo hello-poc' },
      makeCtx(),
      allowAll,
    )) as ToolResult<{ stdout: string; exitCode: number }>;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.stdout.trim()).toBe('hello-poc');
      expect(result.output.exitCode).toBe(0);
    }
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED（没有执行 spawn）', async () => {
    const handler = await registry.resolve('BashPoc');
    const result = await handler.execute({ command: 'rm -rf /' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('超时 → TIMEOUT', async () => {
    const handler = await registry.resolve('BashPoc');
    const result = await handler.execute(
      { command: 'sleep 5', timeout: 200 },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TIMEOUT');
  }, 10_000);

  it('ctx.abortSignal abort → ABORTED', async () => {
    const handler = await registry.resolve('BashPoc');
    const controller = new AbortController();
    const ctx = makeCtx({ abortSignal: controller.signal });
    const promise = handler.execute({ command: 'sleep 2' }, ctx, allowAll);
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  }, 10_000);
});

describe('WebSearchPoc handler', () => {
  let registry: ToolRegistry;
  const originalKeys = {
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    EXA_API_KEY: process.env.EXA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  };

  beforeEach(() => {
    registry = new ToolRegistry();
    registerPocTools(registry);
  });

  afterEach(() => {
    process.env.PERPLEXITY_API_KEY = originalKeys.PERPLEXITY_API_KEY;
    process.env.EXA_API_KEY = originalKeys.EXA_API_KEY;
    process.env.TAVILY_API_KEY = originalKeys.TAVILY_API_KEY;
  });

  it('无 API key → API_KEY_MISSING', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.TAVILY_API_KEY;

    // 注意：createHandler 在第一次 resolve 时就读 env，所以需要新 registry
    const freshRegistry = new ToolRegistry();
    registerPocTools(freshRegistry);
    const handler = await freshRegistry.resolve('WebSearchPoc');

    const result = await handler.execute({ query: 'test' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('API_KEY_MISSING');
  });

  it('有 API key → 返回 mock 结果', async () => {
    process.env.PERPLEXITY_API_KEY = 'pk-fake-for-test';
    const freshRegistry = new ToolRegistry();
    registerPocTools(freshRegistry);
    const handler = await freshRegistry.resolve('WebSearchPoc');

    const result = (await handler.execute(
      { query: 'claude code' },
      makeCtx(),
      allowAll,
    )) as ToolResult<{ results: Array<{ title: string }>; provider: string }>;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.results).toHaveLength(1);
      expect(result.output.provider).toBe('PERPLEXITY');
    }
  });
});

// vitest afterEach needs this import at top but we declared it inline for compactness
import { afterEach } from 'vitest';

// ============================================================================
// A 阶段新增：Glob / Grep / WebFetch POC
// ============================================================================

describe('GlobPoc handler', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-poc-'));
    await fs.writeFile(path.join(tempDir, 'a.ts'), '// a');
    await fs.writeFile(path.join(tempDir, 'b.ts'), '// b');
    await fs.writeFile(path.join(tempDir, 'c.md'), '# c');
    await fs.mkdir(path.join(tempDir, 'nested'));
    await fs.writeFile(path.join(tempDir, 'nested', 'd.ts'), '// d');
  });

  afterEach(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {
      // ignore
    }
  });

  it('匹配 **/*.ts 并排除 .md', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('GlobPoc');
    const result = (await handler.execute(
      { pattern: '**/*.ts' },
      makeCtx({ workingDir: tempDir }),
      allowAll,
    )) as ToolResult<{ files: string[]; count: number }>;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.count).toBe(3);
      expect(result.output.files.every((f) => f.endsWith('.ts'))).toBe(true);
    }
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('GlobPoc');
    const result = await handler.execute(
      { pattern: '**/*.ts' },
      makeCtx({ workingDir: tempDir }),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });
});

describe('GrepPoc handler', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-poc-'));
    await fs.writeFile(path.join(tempDir, 'a.txt'), 'hello\nworld\nfoo\n');
    await fs.writeFile(path.join(tempDir, 'b.txt'), 'bar\nhello world\n');
  });

  afterEach(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {
      // ignore
    }
  });

  it('找到包含 "hello" 的两行', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('GrepPoc');
    const result = (await handler.execute(
      { pattern: 'hello', path: tempDir },
      makeCtx({ workingDir: tempDir }),
      allowAll,
    )) as ToolResult<{ matches: string[]; count: number }>;

    // ripgrep 不存在时 skip，不算 fail
    if (!result.ok && result.code === 'RG_MISSING') {
      return;
    }
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.count).toBe(2);
      expect(result.output.matches.some((m) => m.includes('hello'))).toBe(true);
    }
  });
});

describe('WritePoc handler (dry run)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-poc-'));
  });

  afterEach(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {
      // ignore
    }
  });

  it('新文件 → wouldCreate=true，且不实际写盘', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('WritePoc');

    const newFile = path.join(tempDir, 'never-written.txt');
    const result = (await handler.execute(
      { file_path: newFile, content: 'hello\nworld\n' },
      makeCtx({ workingDir: tempDir }),
      allowAll,
    )) as ToolResult<{ wouldCreate: boolean; wouldUpdate: boolean; bytes: number; lineCount: number; dryRun: true }>;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.wouldCreate).toBe(true);
      expect(result.output.wouldUpdate).toBe(false);
      expect(result.output.bytes).toBe(12);
      expect(result.output.lineCount).toBe(3);
      expect(result.output.dryRun).toBe(true);
    }
    // 关键：文件根本不存在
    await expect(fs.access(newFile)).rejects.toThrow();
  });

  it('已存在文件 → wouldUpdate=true 带 existingBytes', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('WritePoc');

    const existing = path.join(tempDir, 'existing.txt');
    await fs.writeFile(existing, 'old content\n');

    const result = (await handler.execute(
      { file_path: existing, content: 'new content longer\n' },
      makeCtx({ workingDir: tempDir }),
      allowAll,
    )) as ToolResult<{ wouldCreate: boolean; wouldUpdate: boolean; bytes: number; existingBytes?: number }>;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.wouldUpdate).toBe(true);
      expect(result.output.wouldCreate).toBe(false);
      expect(result.output.existingBytes).toBe(12);
      expect(result.output.bytes).toBe(19);
    }
    // 文件内容**未变**
    const after = await fs.readFile(existing, 'utf-8');
    expect(after).toBe('old content\n');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('WritePoc');
    const result = await handler.execute(
      { file_path: '/tmp/whatever', content: 'x' },
      makeCtx(),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });
});

describe('EditPoc handler (dry run)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-poc-'));
  });

  afterEach(async () => {
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {
      // ignore
    }
  });

  it('单次匹配 → wouldReplace=1，文件内容不变', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('EditPoc');

    const file = path.join(tempDir, 'edit.txt');
    const original = 'hello world\nfoo bar\n';
    await fs.writeFile(file, original);

    const result = (await handler.execute(
      { file_path: file, old_text: 'world', new_text: 'planet' },
      makeCtx({ workingDir: tempDir }),
      allowAll,
    )) as ToolResult<{ occurrences: number; wouldReplace: number; bytesDelta: number; dryRun: true }>;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.occurrences).toBe(1);
      expect(result.output.wouldReplace).toBe(1);
      expect(result.output.bytesDelta).toBe(1); // 'planet' - 'world' = +1
      expect(result.output.dryRun).toBe(true);
    }
    expect(await fs.readFile(file, 'utf-8')).toBe(original); // 未变
  });

  it('多次匹配但 replace_all=false → AMBIGUOUS_MATCH', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('EditPoc');

    const file = path.join(tempDir, 'multi.txt');
    await fs.writeFile(file, 'foo foo foo\n');

    const result = await handler.execute(
      { file_path: file, old_text: 'foo', new_text: 'bar' },
      makeCtx({ workingDir: tempDir }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AMBIGUOUS_MATCH');
  });

  it('replace_all=true 全文替换', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('EditPoc');

    const file = path.join(tempDir, 'multi.txt');
    await fs.writeFile(file, 'foo foo foo\n');

    const result = (await handler.execute(
      { file_path: file, old_text: 'foo', new_text: 'bar', replace_all: true },
      makeCtx({ workingDir: tempDir }),
      allowAll,
    )) as ToolResult<{ occurrences: number; wouldReplace: number }>;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.occurrences).toBe(3);
      expect(result.output.wouldReplace).toBe(3);
    }
  });

  it('old_text 不存在 → NOT_FOUND', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('EditPoc');

    const file = path.join(tempDir, 'a.txt');
    await fs.writeFile(file, 'hello');

    const result = await handler.execute(
      { file_path: file, old_text: 'missing', new_text: 'x' },
      makeCtx({ workingDir: tempDir }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });
});

describe('WebFetchPoc handler', () => {
  it('无效 URL → INVALID_URL', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('WebFetchPoc');
    const result = await handler.execute(
      { url: 'not-a-url' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_URL');
  });

  it('非 http(s) 协议 → INVALID_URL', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('WebFetchPoc');
    const result = await handler.execute(
      { url: 'file:///etc/passwd' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_URL');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('WebFetchPoc');
    const result = await handler.execute(
      { url: 'https://example.com' },
      makeCtx(),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('ctx.abortSignal 已 abort → ABORTED', async () => {
    const registry = new ToolRegistry();
    registerPocTools(registry);
    const handler = await registry.resolve('WebFetchPoc');
    const controller = new AbortController();
    controller.abort();
    const result = await handler.execute(
      { url: 'https://example.com' },
      makeCtx({ abortSignal: controller.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });
});

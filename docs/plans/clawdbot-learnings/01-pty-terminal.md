# PTY 伪终端支持

## 问题描述

当前 Code Agent 的 bash 工具使用 `child_process.spawn` 执行命令，没有 PTY（伪终端）支持。这导致：

1. **交互式程序无法运行**：vim、less、top 等需要终端的程序无法正常工作
2. **Coding Agent 调用失败**：Claude Code、Codex CLI 等需要 PTY 才能正常输出
3. **颜色和格式丢失**：很多 CLI 工具在非 TTY 环境下不输出颜色
4. **无法发送控制字符**：Ctrl+C、Ctrl+D 等无法正确传递

## Clawdbot 实现分析

### 核心文件
- `src/agents/bash-tools.exec.ts` (51KB) - 主要执行逻辑
- `src/agents/bash-tools.process.ts` (21KB) - 进程管理
- `src/agents/pty-keys.ts` (6KB) - 按键映射

### 关键实现

```typescript
// Clawdbot 使用 node-pty 创建伪终端
import * as pty from 'node-pty';

const ptyProcess = pty.spawn(shell, args, {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: workdir,
  env: process.env,
});

// 支持的操作
ptyProcess.onData((data) => { /* 输出处理 */ });
ptyProcess.write(input);  // 写入输入
ptyProcess.resize(cols, rows);  // 调整大小
ptyProcess.kill();  // 终止
```

### Bash 工具参数
```typescript
{
  command: string;      // 命令
  pty: boolean;         // 是否使用 PTY（关键！）
  workdir: string;      // 工作目录
  background: boolean;  // 后台运行
  timeout: number;      // 超时（秒）
  elevated: boolean;    // 提权模式
}
```

### Process 工具动作
```typescript
{
  action: 'list' | 'poll' | 'log' | 'write' | 'submit' | 'send-keys' | 'paste' | 'kill';
  sessionId: string;
  data?: string;       // write/submit 的数据
  offset?: number;     // log 的偏移
  limit?: number;      // log 的限制
}
```

## Code Agent 现状

当前实现位于 `src/main/tools/gen1/bash.ts`：

```typescript
// 当前：简单的 spawn，无 PTY
const child = spawn(command, [], {
  shell: true,
  cwd: workingDir,
  env: process.env,
});
```

后台任务支持在 `src/main/tools/backgroundTaskPersistence.ts`，但没有 PTY。

## 借鉴方案

### 方案 A：直接集成 node-pty（推荐）

**优点**：
- 完整 PTY 支持
- 成熟稳定
- Clawdbot 验证过

**缺点**：
- 需要 native 编译
- 打包时需要 rebuild

**实现**：
```typescript
import * as pty from 'node-pty';

interface BashToolInput {
  command: string;
  pty?: boolean;        // 新增
  workdir?: string;
  background?: boolean;
  timeout?: number;
}

function executeBash(input: BashToolInput) {
  if (input.pty) {
    return executePty(input);
  } else {
    return executeSpawn(input);  // 保持原有逻辑
  }
}
```

### 方案 B：使用 xterm.js + node-pty

如果需要在 UI 中展示终端输出，可以配合 xterm.js。但这增加复杂度，建议先做方案 A。

## 实现步骤

### Step 1: 安装依赖
```bash
npm install node-pty
```

注意：node-pty 是 native 模块，需要配置 electron-rebuild：
```json
// package.json
{
  "scripts": {
    "postinstall": "electron-rebuild -f -w node-pty"
  }
}
```

### Step 2: 创建 PTY 执行器

新建 `src/main/tools/gen1/ptyExecutor.ts`：

```typescript
import * as pty from 'node-pty';
import { EventEmitter } from 'events';

export interface PtySession {
  id: string;
  process: pty.IPty;
  output: string[];
  status: 'running' | 'exited';
  exitCode?: number;
  startedAt: number;
}

const sessions = new Map<string, PtySession>();

export function createPtySession(params: {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
}): PtySession {
  const id = `pty_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const ptyProcess = pty.spawn(shell, ['-c', params.command], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: params.workdir || process.cwd(),
    env: { ...process.env, ...params.env },
  });

  const session: PtySession = {
    id,
    process: ptyProcess,
    output: [],
    status: 'running',
    startedAt: Date.now(),
  };

  ptyProcess.onData((data) => {
    session.output.push(data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.status = 'exited';
    session.exitCode = exitCode;
  });

  sessions.set(id, session);
  return session;
}

export function getSession(id: string): PtySession | undefined {
  return sessions.get(id);
}

export function writeToSession(id: string, data: string): boolean {
  const session = sessions.get(id);
  if (!session || session.status !== 'running') return false;
  session.process.write(data);
  return true;
}

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.process.kill();
  sessions.delete(id);
  return true;
}
```

### Step 3: 扩展 bash 工具

修改 `src/main/tools/gen1/bash.ts`：

```typescript
import { createPtySession, getSession, writeToSession, killSession } from './ptyExecutor';

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: '...',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      pty: { type: 'boolean', description: '使用伪终端（交互式程序需要）' },
      workdir: { type: 'string' },
      background: { type: 'boolean' },
      timeout: { type: 'number' },
    },
    required: ['command'],
  },
  execute: async (input, context) => {
    if (input.pty) {
      // PTY 模式
      const session = createPtySession({
        command: input.command,
        workdir: input.workdir,
      });

      if (input.background) {
        return { sessionId: session.id, status: 'started' };
      }

      // 等待完成
      await waitForExit(session, input.timeout);
      return {
        output: session.output.join(''),
        exitCode: session.exitCode,
      };
    } else {
      // 原有 spawn 逻辑
      return executeSpawn(input);
    }
  },
};
```

### Step 4: 添加 process 工具

新建 `src/main/tools/gen1/process.ts`：

```typescript
export const processTool: ToolDefinition = {
  name: 'process',
  description: '管理后台进程',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'poll', 'log', 'write', 'submit', 'send-keys', 'kill']
      },
      sessionId: { type: 'string' },
      data: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['action'],
  },
  execute: async (input) => {
    switch (input.action) {
      case 'list':
        return listSessions();
      case 'poll':
        return pollSession(input.sessionId);
      case 'log':
        return getSessionLog(input.sessionId, input.offset, input.limit);
      case 'write':
        return writeToSession(input.sessionId, input.data);
      case 'submit':
        return writeToSession(input.sessionId, input.data + '\n');
      case 'kill':
        return killSession(input.sessionId);
      // ...
    }
  },
};
```

### Step 5: 更新工具注册

在 `src/main/tools/generationMap.ts` 中添加 process 工具。

### Step 6: 测试

```typescript
// 测试 PTY 模式
const result = await bashTool.execute({
  command: 'vim --version | head -5',
  pty: true,
});

// 测试后台 + 交互
const { sessionId } = await bashTool.execute({
  command: 'python3',
  pty: true,
  background: true,
});

await processTool.execute({ action: 'submit', sessionId, data: 'print("hello")' });
await processTool.execute({ action: 'log', sessionId });
await processTool.execute({ action: 'kill', sessionId });
```

## 验收标准

1. **基础 PTY**：`bash pty:true command:"vim --version"` 正常输出
2. **后台模式**：`bash pty:true background:true command:"python3"` 返回 sessionId
3. **进程交互**：process write/submit 能发送输入
4. **进程管理**：process list/poll/log/kill 正常工作
5. **Coding Agent**：`bash pty:true command:"claude 'hello'"` 能正常运行

## 风险与注意事项

1. **Native 模块**：node-pty 需要编译，CI/CD 需要配置
2. **跨平台**：Windows 上需要额外测试
3. **资源泄露**：确保 session 清理机制
4. **安全**：PTY 有完整终端权限，需要权限控制

## 参考资料

- [node-pty GitHub](https://github.com/microsoft/node-pty)
- [Clawdbot bash-tools.exec.ts](https://github.com/clawdbot/clawdbot/blob/main/src/agents/bash-tools.exec.ts)
- [xterm.js](https://xtermjs.org/) - 可选的终端 UI

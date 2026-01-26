# Agent-Refactor 提示词

> 用途：执行 TASK-03 主进程重构 + TASK-04 接口规范化
> 预估时间：3 周
> 依赖：TASK-01 和 TASK-02 完成后开始

---

## 角色设定

你是一个专注于代码重构的 Agent。你的任务是将 Code Agent 的主进程从 2000+ 行精简到模块化结构，并规范化接口设计。

## 任务文档

请按顺序阅读：
1. `docs/refactor/TASK-03-main-refactor.md`
2. `docs/refactor/TASK-04-interface.md`

## 前置条件

**开始前必须确认**：
- [ ] TASK-01 (安全加固) 已合并到 main
- [ ] TASK-02 (热更新系统) 已合并到 main
- [ ] `CloudConfigService` 可正常工作
- [ ] `npm run typecheck` 通过

## 工作范围

### 第一阶段：主进程重构 (TASK-03)

**新增目录和文件**：
```
src/main/
├── app/
│   ├── bootstrap.ts      # 服务初始化
│   ├── window.ts         # 窗口管理
│   └── lifecycle.ts      # app 事件
├── ipc/
│   ├── index.ts          # IPC 注册入口
│   ├── agent.ipc.ts
│   ├── session.ipc.ts
│   ├── generation.ipc.ts
│   ├── auth.ipc.ts
│   ├── sync.ipc.ts
│   ├── cloud.ipc.ts
│   ├── workspace.ipc.ts
│   ├── settings.ipc.ts
│   ├── update.ipc.ts
│   └── mcp.ipc.ts
└── tools/
    ├── generationMap.ts  # 代际映射
    ├── file/             # 文件工具
    ├── shell/            # Shell 工具
    ├── planning/         # 规划工具
    ├── network/          # 网络工具
    ├── mcp/              # MCP 工具
    ├── memory/           # 记忆工具
    ├── vision/           # 视觉工具
    ├── multiagent/       # 多代理工具
    └── evolution/        # 进化工具
```

**移动和重组**：
- 35 个工具文件从 gen1-gen8 移到功能目录
- 16 个服务文件分到 core/auth/sync/cloud/infra

### 第二阶段：接口规范化 (TASK-04)

**新增文件**：
```
src/shared/ipc/protocol.ts             # IPC 协议定义
src/shared/types/                      # 类型拆分（14 个文件）
vercel-api/api/v1/                     # API 版本化
```

## 工作流程

1. **拉取最新代码**
   ```bash
   git checkout main
   git pull
   git checkout -b feature/task-03-refactor
   ```

2. **完成 TASK-03**
   - 创建 app/ 目录，拆分 bootstrap/window/lifecycle
   - 创建 ipc/ 目录，拆分 10 个 handler 文件
   - 精简 index.ts 到 < 100 行
   - 重组工具目录
   - 整理服务目录

3. **验证 TASK-03**
   ```bash
   npm run typecheck
   npm run dev
   wc -l src/main/index.ts  # 应 < 100
   ```

4. **提交 TASK-03**
   ```bash
   git add .
   git commit -m "refactor(main): 完成主进程重构 TASK-03"
   ```

5. **继续 TASK-04**
   - 创建 IPC 协议
   - 云端 API 版本化
   - 类型定义拆分

6. **验证 TASK-04**
   ```bash
   npm run typecheck
   curl -s "https://code-agent-beta.vercel.app/api/v1/config"
   ```

7. **最终提交**
   ```bash
   git add .
   git commit -m "refactor(interface): 完成接口规范化 TASK-04"
   git push origin feature/task-03-refactor
   ```

## 关键技术点

### index.ts 精简后结构

```typescript
// src/main/index.ts (< 100 行)
import { app } from 'electron';
import { bootstrap } from './app/bootstrap';
import { createWindow } from './app/window';
import { setupLifecycle } from './app/lifecycle';
import { registerAllHandlers } from './ipc';

setupLifecycle();

app.whenReady().then(async () => {
  await bootstrap();
  registerAllHandlers();
  createWindow();
});
```

### IPC Handler 拆分模式

```typescript
// src/main/ipc/agent.ipc.ts
import { ipcMain } from 'electron';
import { AgentOrchestrator } from '../agent/agentOrchestrator';

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:send-message', async (event, content) => {
    return AgentOrchestrator.sendMessage(content);
  });

  ipcMain.handle('agent:cancel', async () => {
    return AgentOrchestrator.cancel();
  });
}
```

### 代际映射配置

```typescript
// src/main/tools/generationMap.ts
export const GENERATION_TOOLS: Record<GenerationId, string[]> = {
  gen1: ['bash', 'read_file', 'write_file', 'edit_file'],
  gen2: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory'],
  gen3: [...gen2, 'task', 'todo_write', 'ask_user_question', 'plan_read', 'plan_update', 'enter_plan_mode', 'exit_plan_mode', 'findings_write'],
  // ...
};
```

## 验收标准

### TASK-03
- [ ] `src/main/index.ts` < 100 行
- [ ] 所有工具按功能目录组织
- [ ] 所有服务按领域目录组织
- [ ] 35 个工具可正常执行
- [ ] `npm run dev` 启动正常

### TASK-04
- [ ] IPC 通道数从 70+ 降到 ~15 个
- [ ] 旧 IPC 通道仍可用（兼容）
- [ ] 所有云端 API 带 /v1/ 前缀
- [ ] 类型定义拆分为 14 个文件
- [ ] `npm run typecheck` 通过

## 注意事项

1. **不要破坏现有功能**：每个步骤都要验证
2. **保持向后兼容**：旧 IPC 通道标记 deprecated 但保留
3. **导入路径更新**：使用 IDE 重构功能
4. **文件不要重命名**：由 TASK-05 统一处理
5. **大量文件移动**：建议使用脚本或 IDE 批量操作

## 与其他 Agent 的边界

- 你依赖 TASK-02 的 `CloudConfigService`，但不修改它
- 不要修改安全相关代码（TASK-01 范围）
- 不要重命名文件（TASK-05 范围）

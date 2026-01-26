# Agent-Quality 提示词

> 用途：执行 TASK-05 编码规范统一
> 预估时间：1 周
> 依赖：TASK-04 完成后开始

---

## 角色设定

你是一个专注于代码质量的 Agent。你的任务是统一 Code Agent 项目的编码规范，消除技术债务。

## 任务文档

请阅读 `docs/refactor/TASK-05-code-quality.md` 获取详细任务清单。

## 前置条件

**开始前必须确认**：
- [ ] TASK-04 (接口规范化) 已合并到 main
- [ ] 目录结构和类型定义已稳定
- [ ] `npm run typecheck` 通过

## 工作范围

### 你的任务

1. **文件重命名** (~50 个)
   - PascalCase → camelCase

2. **消除 as any** (~30 处)
   - 添加正确类型
   - 使用类型守卫

3. **日志规范化** (~200 处)
   - 创建 Logger 服务
   - 替换 console.log

4. **常量提取**
   - 消除魔法数字
   - 集中管理常量

5. **ESLint 配置**
   - 添加命名规则
   - 添加 no-any 规则
   - 添加 no-console 规则

### 你负责的文件

```
# 重命名（示例）
src/main/agent/AgentOrchestrator.ts → agentOrchestrator.ts
src/main/tools/ToolRegistry.ts → toolRegistry.ts
... 约 50 个

# 新增
src/main/services/infra/logger.ts
src/shared/constants.ts

# 修改
.eslintrc.json
所有包含 console.log 的文件
所有包含 as any 的文件
```

## 工作流程

1. **拉取最新代码**
   ```bash
   git checkout main
   git pull
   git checkout -b feature/task-05-quality
   ```

2. **文件重命名**
   ```bash
   # 使用脚本批量重命名
   npx ts-node scripts/rename-files.ts

   # 或使用 IDE 重构功能（推荐）
   ```

3. **创建 Logger**
   - 创建 `src/main/services/infra/logger.ts`
   - 实现日志分级和脱敏

4. **替换 console.log**
   ```bash
   # 搜索所有 console.log
   grep -r "console.log" src/

   # 批量替换（谨慎操作）
   ```

5. **消除 as any**
   ```bash
   # 搜索所有 as any
   grep -r "as any" src/

   # 逐个修复
   ```

6. **提取常量**
   - 创建 `src/shared/constants.ts`
   - 搜索魔法数字并替换

7. **配置 ESLint**
   - 更新 `.eslintrc.json`
   - 运行 `npm run lint` 确认零警告

8. **验证**
   ```bash
   npm run typecheck
   npm run lint
   npm run dev
   ```

9. **提交**
   ```bash
   git add .
   git commit -m "refactor(quality): 完成编码规范统一 TASK-05"
   git push origin feature/task-05-quality
   ```

## 关键技术点

### 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 文件名 | camelCase | `agentOrchestrator.ts` |
| 目录名 | kebab-case | `cloud-config/` |
| 类名 | PascalCase | `AgentOrchestrator` |
| 工具 API | snake_case | `read_file` |
| 函数 | camelCase | `executeReadFile` |
| 常量 | UPPER_SNAKE | `MAX_ITERATIONS` |

### Logger 实现

```typescript
// src/main/services/infra/logger.ts
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel;
  private context?: string;

  constructor(context?: string) {
    this.context = context;
    this.level = process.env.NODE_ENV === 'production'
      ? LogLevel.INFO
      : LogLevel.DEBUG;
  }

  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;

  private sanitize(obj?: Record<string, unknown>): Record<string, unknown> | undefined {
    // 脱敏 apiKey, password, token, secret
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context);
}
```

### 替换 console.log 示例

```typescript
// 之前
console.log('Agent started', { sessionId });

// 之后
import { createLogger } from '@/main/services/infra/logger';
const logger = createLogger('AgentLoop');
logger.info('Agent started', { sessionId });
```

### 消除 as any 示例

```typescript
// 错误
const data = response.data as any;

// 正确方式 1
const data = response.data as ResponseData;

// 正确方式 2
function isResponseData(obj: unknown): obj is ResponseData {
  return obj !== null && typeof obj === 'object' && 'id' in obj;
}
```

### 常量定义

```typescript
// src/shared/constants.ts
export const AGENT = {
  MAX_ITERATIONS: 30,
  MAX_RETRIES: 3,
  DEFAULT_TIMEOUT: 60000,
} as const;

export const CACHE = {
  CONFIG_TTL: 3600000,
  TOKEN_TTL: 86400000,
} as const;
```

## 验收标准

- [ ] 所有文件名符合 camelCase 规范
- [ ] `npm run lint` 零警告
- [ ] 全局无 `as any`
- [ ] 全局无 `console.log`
- [ ] 全局无魔法数字
- [ ] `npm run typecheck` 通过
- [ ] `npm run dev` 启动正常

## 注意事项

1. **批量重命名风险高**：建议使用 IDE 重构功能
2. **导入路径必须同步更新**：重命名后检查所有 import
3. **不要改业务逻辑**：只做规范化
4. **console.log 替换要分批**：先替换关键模块
5. **保留 console.error 用于异常**：部分场景需要

## 与其他 Agent 的边界

- 依赖 TASK-04 完成的目录结构
- 不要修改工具执行逻辑
- 不要新增功能

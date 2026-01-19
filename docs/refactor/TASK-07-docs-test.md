# TASK-07: 文档和测试

> 负责 Agent: Agent-Docs
> 优先级: P2
> 预估时间: 1 周
> 依赖: TASK-06 完成
> 状态: 待执行

---

## 目标

1. 更新架构文档，与重构后代码同步
2. 生成 API 文档（TypeDoc + OpenAPI）
3. 补充核心模块单元测试

---

## 前置检查

开始前确认：
- [ ] TASK-06 (扩展性增强) 已完成
- [ ] 所有代码变更已稳定
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过

---

## 任务清单

### 7.1 架构文档更新

**需更新的文档**:

| 文档 | 更新内容 |
|------|---------|
| `docs/architecture/overview.md` | 新目录结构、模块关系图 |
| `docs/architecture/tool-system.md` | 工具目录重组、装饰器用法 |
| `docs/architecture/agent-core.md` | IPC 协议变更 |
| `docs/architecture/data-storage.md` | 无变化（验证） |
| `docs/architecture/cloud-architecture.md` | 云端配置中心、API v1 |

**需新增的文档**:

| 文档 | 内容 |
|------|------|
| `docs/architecture/hot-update.md` | 热更新系统设计 |
| `docs/architecture/plugin-system.md` | 插件系统设计 |

**步骤**:
- [ ] 更新 `overview.md`，包含新目录结构图
- [ ] 更新 `tool-system.md`，添加装饰器使用示例
- [ ] 更新 `cloud-architecture.md`，添加配置中心说明
- [ ] 新增 `hot-update.md`
- [ ] 新增 `plugin-system.md`
- [ ] 更新 `CLAUDE.md` 目录结构部分

**overview.md 新目录结构**:
```
src/
├── main/
│   ├── index.ts              # 入口 (< 100 行)
│   ├── app/                  # 应用启动
│   │   ├── bootstrap.ts
│   │   ├── window.ts
│   │   └── lifecycle.ts
│   ├── ipc/                  # IPC 处理器
│   │   └── *.ipc.ts
│   ├── agent/                # Agent 核心
│   ├── tools/                # 工具（按功能分类）
│   │   ├── file/
│   │   ├── shell/
│   │   ├── planning/
│   │   ├── network/
│   │   ├── mcp/
│   │   ├── memory/
│   │   ├── vision/
│   │   ├── multiagent/
│   │   └── evolution/
│   ├── services/             # 服务（按领域分类）
│   │   ├── core/
│   │   ├── auth/
│   │   ├── sync/
│   │   ├── cloud/
│   │   └── infra/
│   ├── plugin/               # 插件系统
│   └── mcp/                  # MCP 协议
├── renderer/                 # React 前端
├── preload/                  # 预加载脚本
└── shared/                   # 共享类型
    └── types/                # 按领域拆分
```

---

### 7.2 CLAUDE.md 更新

**更新内容**:
- [ ] 目录结构（与 overview.md 同步）
- [ ] 常用命令（无变化）
- [ ] 工具列表（按新目录组织）
- [ ] 云端 API 端点更新为 v1
- [ ] 新增热更新说明
- [ ] 新增插件系统说明

---

### 7.3 API 文档生成

**TypeDoc 配置**:
```bash
npm install --save-dev typedoc
```

```json
// typedoc.json
{
  "entryPoints": ["src/main/index.ts", "src/shared/types/index.ts"],
  "out": "docs/api",
  "exclude": ["**/*.test.ts", "**/node_modules/**"],
  "excludePrivate": true,
  "excludeProtected": true
}
```

**步骤**:
- [ ] 安装 TypeDoc
- [ ] 配置 `typedoc.json`
- [ ] 为核心类添加 JSDoc 注释
- [ ] 生成文档到 `docs/api/`
- [ ] 添加 `npm run docs` 命令

**需要添加 JSDoc 的核心类**:
- `AgentOrchestrator`
- `AgentLoop`
- `ToolRegistry`
- `ToolExecutor`
- `CloudConfigService`
- `FeatureFlagService`
- `PluginRegistry`

---

### 7.4 OpenAPI 文档

**云端 API 文档**:
```yaml
# vercel-api/openapi.yaml
openapi: 3.0.0
info:
  title: Code Agent Cloud API
  version: 1.0.0
  description: Code Agent 云端 API

servers:
  - url: https://code-agent-beta.vercel.app/api/v1

paths:
  /config:
    get:
      summary: 获取云端配置
      parameters:
        - name: version
          in: query
          schema:
            type: boolean
          description: 只返回版本号
      responses:
        '200':
          description: 配置数据
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CloudConfig'

  /agent:
    post:
      summary: 提交 Agent 任务
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AgentRequest'
      responses:
        '200':
          description: 任务结果

components:
  schemas:
    CloudConfig:
      type: object
      properties:
        version:
          type: string
        prompts:
          type: object
        skills:
          type: array
        toolMeta:
          type: object
        featureFlags:
          type: object
        uiStrings:
          type: object
```

**步骤**:
- [ ] 创建 `vercel-api/openapi.yaml`
- [ ] 定义所有 v1 端点
- [ ] 添加 Swagger UI（可选）

---

### 7.5 IPC 文档

**创建 IPC 通道文档**:
```markdown
# IPC 通道文档

## 协议格式

请求:
{
  "action": string,
  "payload": any,
  "requestId"?: string
}

响应:
{
  "success": boolean,
  "data"?: any,
  "error"?: { "code": string, "message": string }
}

## 通道列表

### agent
- send: 发送消息
- cancel: 取消执行
- retry: 重试

### session
- list: 列出会话
- create: 创建会话
- load: 加载会话
- delete: 删除会话
- export: 导出会话

...
```

**步骤**:
- [ ] 创建 `docs/ipc-channels.md`
- [ ] 文档化所有 15 个领域通道
- [ ] 每个 action 说明参数和返回值

---

### 7.6 测试补充

**测试框架**: Vitest（已配置）

**需要补充测试的模块**:

| 模块 | 测试文件 | 覆盖要求 |
|------|---------|---------|
| 文件工具 | `tests/tools/file.test.ts` | 80%+ |
| Shell 工具 | `tests/tools/shell.test.ts` | 80%+ |
| CloudConfigService | `tests/services/cloudConfig.test.ts` | 80%+ |
| FeatureFlagService | `tests/services/featureFlag.test.ts` | 80%+ |
| PluginLoader | `tests/plugin/pluginLoader.test.ts` | 80%+ |
| IPC 协议 | `tests/ipc/protocol.test.ts` | 80%+ |

**测试示例**:
```typescript
// tests/services/cloudConfig.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudConfigService } from '@/main/services/cloud/cloudConfigService';

describe('CloudConfigService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should fetch config from cloud', async () => {
    const service = new CloudConfigService();
    await service.initialize();

    const prompt = service.getPrompt('gen4');
    expect(prompt).toBeDefined();
    expect(typeof prompt).toBe('string');
  });

  it('should fallback to builtin config when offline', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    const service = new CloudConfigService();
    await service.initialize();

    // 应该使用内置配置，不抛错
    const prompt = service.getPrompt('gen4');
    expect(prompt).toBeDefined();
  });

  it('should cache config for 1 hour', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');

    const service = new CloudConfigService();
    await service.initialize();
    await service.refresh();
    await service.refresh();

    // 在缓存期内只应调用一次
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
```

**步骤**:
- [ ] 创建测试目录结构
- [ ] 编写文件工具测试
- [ ] 编写 Shell 工具测试
- [ ] 编写 CloudConfigService 测试
- [ ] 编写 FeatureFlagService 测试
- [ ] 编写 PluginLoader 测试
- [ ] 编写 IPC 协议测试
- [ ] 运行 `npm run test` 确认全部通过
- [ ] 检查覆盖率 > 80%

---

### 7.7 热更新 E2E 测试

**测试场景**:
1. 修改云端 Skill 定义 → 客户端重启后生效
2. 修改 Feature Flag → 功能开关生效
3. 网络断开 → 使用本地缓存

**步骤**:
- [ ] 创建 `tests/e2e/hotUpdate.test.ts`
- [ ] 使用 MSW 模拟云端 API
- [ ] 测试配置更新流程

---

## 涉及文件汇总

| 操作 | 文件 |
|------|------|
| 更新 | `docs/architecture/*.md` (5 个) |
| 新增 | `docs/architecture/hot-update.md` |
| 新增 | `docs/architecture/plugin-system.md` |
| 更新 | `CLAUDE.md` |
| 新增 | `vercel-api/openapi.yaml` |
| 新增 | `docs/ipc-channels.md` |
| 新增 | `tests/**/*.test.ts` (6+ 个) |
| 新增 | `typedoc.json` |

---

## 验收标准

- [ ] 所有架构文档与代码同步
- [ ] TypeDoc 生成成功，无警告
- [ ] OpenAPI 文档完整
- [ ] IPC 通道文档完整
- [ ] 核心模块测试覆盖 > 80%
- [ ] `npm run test` 全部通过
- [ ] `npm run docs` 命令可用

---

## 交接备注

_（任务完成后填写）_

- 完成时间:
- 文档访问地址:
- 测试覆盖率报告:
- 遗留问题:

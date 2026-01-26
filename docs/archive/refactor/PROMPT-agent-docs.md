# Agent-Docs 提示词

> 用途：执行 TASK-07 文档和测试
> 预估时间：1 周
> 依赖：TASK-06 完成后开始

---

## 角色设定

你是一个专注于文档和测试的 Agent。你的任务是更新 Code Agent 项目的架构文档，并补充核心模块测试。

## 任务文档

请阅读 `docs/refactor/TASK-07-docs-test.md` 获取详细任务清单。

## 前置条件

**开始前必须确认**：
- [ ] TASK-06 (扩展性增强) 已合并到 main
- [ ] 所有代码变更已稳定
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过

## 工作范围

### 你的任务

1. **架构文档更新**
   - 更新 5 个现有文档
   - 新增 2 个文档

2. **CLAUDE.md 更新**
   - 目录结构
   - API 端点
   - 新功能说明

3. **API 文档生成**
   - TypeDoc 配置
   - JSDoc 注释补充
   - OpenAPI 文档

4. **IPC 文档**
   - 新协议文档
   - 所有通道说明

5. **测试补充**
   - 核心模块单元测试
   - 覆盖率 > 80%

### 你负责的文件

```
# 更新
docs/architecture/overview.md
docs/architecture/tool-system.md
docs/architecture/agent-core.md
docs/architecture/cloud-architecture.md
CLAUDE.md

# 新增
docs/architecture/hot-update.md
docs/architecture/plugin-system.md
docs/ipc-channels.md
vercel-api/openapi.yaml
typedoc.json

# 测试
tests/tools/file.test.ts
tests/tools/shell.test.ts
tests/services/cloudConfig.test.ts
tests/services/featureFlag.test.ts
tests/plugin/pluginLoader.test.ts
tests/ipc/protocol.test.ts
```

## 工作流程

1. **拉取最新代码**
   ```bash
   git checkout main
   git pull
   git checkout -b feature/task-07-docs
   ```

2. **更新架构文档**
   - 阅读代码了解当前结构
   - 更新每个文档

3. **更新 CLAUDE.md**
   - 目录结构与 overview.md 同步
   - 更新 API 端点到 v1

4. **生成 API 文档**
   ```bash
   npm install --save-dev typedoc
   npx typedoc
   ```

5. **编写测试**
   ```bash
   npm run test
   npm run test:coverage
   ```

6. **验证**
   ```bash
   npm run docs       # 生成文档
   npm run test       # 运行测试
   ```

7. **提交**
   ```bash
   git add .
   git commit -m "docs: 完成文档和测试 TASK-07"
   git push origin feature/task-07-docs
   ```

## 关键技术点

### 新目录结构图

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
│   │   ├── decorators/       # 装饰器
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
    ├── types/                # 按领域拆分
    ├── ipc/                  # IPC 协议
    └── constants.ts          # 常量
```

### TypeDoc 配置

```json
// typedoc.json
{
  "entryPoints": ["src/main/index.ts", "src/shared/types/index.ts"],
  "out": "docs/api",
  "exclude": ["**/*.test.ts"],
  "excludePrivate": true
}
```

### OpenAPI 示例

```yaml
# vercel-api/openapi.yaml
openapi: 3.0.0
info:
  title: Code Agent Cloud API
  version: 1.0.0

servers:
  - url: https://code-agent-beta.vercel.app/api/v1

paths:
  /config:
    get:
      summary: 获取云端配置
      responses:
        '200':
          description: 配置数据
```

### 测试示例

```typescript
// tests/services/cloudConfig.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CloudConfigService } from '@/main/services/cloud/cloudConfigService';

describe('CloudConfigService', () => {
  it('should fetch config from cloud', async () => {
    const service = new CloudConfigService();
    await service.initialize();

    const prompt = service.getPrompt('gen4');
    expect(prompt).toBeDefined();
  });

  it('should fallback to builtin when offline', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network'));

    const service = new CloudConfigService();
    await service.initialize();

    const prompt = service.getPrompt('gen4');
    expect(prompt).toBeDefined();
  });
});
```

## 验收标准

- [ ] 所有架构文档与代码同步
- [ ] CLAUDE.md 目录结构准确
- [ ] TypeDoc 生成成功
- [ ] OpenAPI 文档完整
- [ ] IPC 通道文档完整
- [ ] 核心模块测试覆盖 > 80%
- [ ] `npm run test` 全部通过
- [ ] `npm run docs` 命令可用

## 文档写作要求

1. **与代码同步**：确保文档描述与实际代码一致
2. **包含示例**：每个概念都要有代码示例
3. **图表清晰**：目录结构、流程图要准确
4. **中文为主**：文档使用中文，代码标识用英文
5. **保持简洁**：不要过度解释，点到为止

## 测试编写要求

1. **覆盖关键路径**：正常流程、异常流程都要测
2. **Mock 外部依赖**：网络、文件系统等
3. **测试隔离**：每个测试独立，不依赖执行顺序
4. **断言明确**：每个测试要有清晰的断言
5. **命名规范**：`should xxx when yyy`

## 注意事项

1. 先阅读代码再写文档
2. 文档更新要与代码对照
3. 测试要覆盖边界情况
4. 不要写过时的内容
5. 图表可以用 Mermaid 语法

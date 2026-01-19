# Agent-Cloud 提示词

> 用途：执行 TASK-02 热更新系统任务
> 预估时间：2 周
> 可并行：是（与 Agent-Security 并行）

---

## 角色设定

你是一个专注于云端服务开发的 Agent。你的任务是构建 Code Agent 的热更新系统，包括云端配置中心和客户端配置服务。

## 任务文档

请阅读 `docs/refactor/TASK-02-hot-update.md` 获取详细任务清单。

## 工作范围

### 你负责的文件

```
# 云端
vercel-api/api/v1/config.ts            # 新增：统一配置端点
vercel-api/api/prompts.ts              # 修改：添加重定向

# 客户端服务
src/main/services/cloud/CloudConfigService.ts    # 新增
src/main/services/cloud/FeatureFlagService.ts    # 新增
src/main/services/cloud/builtinConfig.ts         # 新增：内置配置

# 工具修改
src/main/tools/gen4/skill.ts           # 修改：从云端读取 Skills
src/main/tools/ToolRegistry.ts         # 修改：合并云端元数据

# 前端
src/renderer/hooks/useI18n.ts          # 新增
src/renderer/i18n/zh.ts                # 新增
src/renderer/i18n/en.ts                # 新增
```

### 禁止修改的文件

```
src/main/index.ts                      # 由 Agent-Refactor 重构
src/main/services/SecureStorage.ts     # 由 Agent-Security 修改
package.json (extraResources)          # 由 Agent-Security 修改
```

## 工作流程

1. **阅读任务文档**
   ```
   先阅读 docs/refactor/TASK-02-hot-update.md
   ```

2. **创建分支**
   ```bash
   git checkout -b feature/task-02-hot-update
   ```

3. **按顺序完成任务**
   - 2.1 云端配置中心 `/api/v1/config`
   - 2.2 客户端 CloudConfigService
   - 2.3 FeatureFlagService
   - 2.4 Skills 动态化
   - 2.5 工具元数据动态化
   - 2.6 UI 文案动态化

4. **验证**
   ```bash
   # 云端
   curl -s "https://code-agent-beta.vercel.app/api/v1/config" | jq '.version'

   # 客户端
   npm run typecheck
   npm run dev
   ```

5. **提交**
   ```bash
   git add .
   git commit -m "feat(cloud): 完成热更新系统 TASK-02"
   git push origin feature/task-02-hot-update
   ```

## 关键技术点

### CloudConfig 接口

```typescript
interface CloudConfig {
  version: string;
  prompts: Record<GenerationId, string>;
  skills: SkillDefinition[];
  toolMeta: Record<string, ToolMetadata>;
  featureFlags: FeatureFlags;
  uiStrings: {
    zh: Record<string, string>;
    en: Record<string, string>;
  };
  rules: Record<string, string>;
}
```

### 缓存策略

```typescript
class CloudConfigService {
  private cache: CloudConfig | null = null;
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL = 3600000; // 1 小时

  async getConfig(): Promise<CloudConfig> {
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }

    try {
      const config = await this.fetchConfig();
      this.cache = config;
      this.cacheExpiry = Date.now() + this.CACHE_TTL;
      return config;
    } catch (error) {
      // 离线降级到内置配置
      return this.loadBuiltinConfig();
    }
  }
}
```

### ETag 缓存

```typescript
// vercel-api/api/v1/config.ts
export default function handler(req, res) {
  const config = getCloudConfig();
  const etag = generateETag(config);

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  res.setHeader('ETag', etag);
  res.json(config);
}
```

## 验收标准

- [ ] `/api/v1/config` 返回完整配置
- [ ] 修改云端 Skill 后客户端自动生效
- [ ] Feature Flag 关闭后功能不可用
- [ ] 离线时使用本地缓存，不报错
- [ ] 设置页面有「刷新配置」按钮

## 注意事项

1. 云端 API 需要考虑 ETag 缓存
2. 客户端初始化不能阻塞窗口创建
3. 离线降级必须无感，不能弹错误
4. 先完成云端再做客户端
5. 内置配置要与云端保持同步

## 与 Agent-Security 的边界

你们可以并行工作，文件不重叠：
- 你负责 `vercel-api/` 和 `src/main/services/cloud/`
- Security 负责 `package.json` 和 `SecureStorage.ts`

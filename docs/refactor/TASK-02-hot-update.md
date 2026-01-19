# TASK-02: 热更新系统

> 负责 Agent: Agent-Cloud
> 优先级: P0
> 预估时间: 2 周
> 依赖: 无
> 状态: 已完成

---

## 目标

构建云端配置中心，实现 Skill、工具元数据、Feature Flags、UI 文案的热更新能力。

改造后约 60-70% 的日常改动可通过云端热更新，无需发版。

---

## 任务清单

### 2.1 云端配置中心

**新增文件**:
- `vercel-api/api/v1/config.ts`

**接口设计**:
```typescript
// GET /api/v1/config
// Query: ?version=true (只返回版本号，用于检查更新)

interface CloudConfig {
  version: string;                              // 配置版本，如 "2025.01.19.1"
  prompts: Record<GenerationId, string>;        // 各代际 System Prompt
  skills: SkillDefinition[];                    // Skill 定义
  toolMeta: Record<string, ToolMetadata>;       // 工具描述和参数
  featureFlags: FeatureFlags;                   // 功能开关
  uiStrings: {                                  // UI 文案
    zh: Record<string, string>;
    en: Record<string, string>;
  };
  rules: Record<string, string>;                // Agent 规则
}
```

**步骤**:
- [ ] 创建 `vercel-api/api/v1/config.ts`
- [ ] 迁移现有 `/api/prompts` 数据到新接口的 `prompts` 字段
- [ ] 添加 ETag 缓存控制（304 Not Modified）
- [ ] 添加 `version` 字段用于客户端检查更新
- [ ] 旧 `/api/prompts` 返回 301 重定向到新接口

**验收**:
```bash
curl -s "https://code-agent-beta.vercel.app/api/v1/config" | jq '.version'
curl -s "https://code-agent-beta.vercel.app/api/v1/config?version=true"
```

---

### 2.2 客户端配置服务

**新增文件**:
- `src/main/services/cloud/CloudConfigService.ts`

**类设计**:
```typescript
class CloudConfigService {
  private cache: CloudConfig | null = null;
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL = 3600000; // 1 小时

  async initialize(): Promise<void>;           // 启动时调用
  async refresh(): Promise<void>;              // 手动刷新

  getPrompt(genId: GenerationId): string;
  getSkills(): SkillDefinition[];
  getToolMeta(name: string): ToolMetadata;
  getFeatureFlag(key: string): boolean;
  getUIString(key: string, lang: Language): string;
  getRule(name: string): string;

  private async fetchConfig(): Promise<CloudConfig>;
  private loadBuiltinConfig(): CloudConfig;    // 离线降级
}
```

**步骤**:
- [ ] 创建 `CloudConfigService` 单例
- [ ] 启动时异步拉取配置（不阻塞窗口创建）
- [ ] 本地缓存 + 1 小时过期
- [ ] 拉取失败时降级到内置配置（不报错）
- [ ] 暴露 IPC 接口：`cloud:refresh-config`

**内置配置位置**: `src/main/services/cloud/builtinConfig.ts`

---

### 2.3 Feature Flags 服务

**新增文件**:
- `src/main/services/cloud/FeatureFlagService.ts`

**Flags 定义**:
```typescript
interface FeatureFlags {
  enableGen8: boolean;           // 是否启用 Gen8 自我进化
  enableCloudAgent: boolean;     // 是否启用云端 Agent
  enableMemory: boolean;         // 是否启用记忆系统
  enableComputerUse: boolean;    // 是否启用 Computer Use
  maxIterations: number;         // 最大迭代次数
  maxMessageLength: number;      // 最大消息长度
  enableExperimentalTools: boolean; // 实验性工具
}
```

**步骤**:
- [ ] 创建 `FeatureFlagService`
- [ ] 从 `CloudConfigService` 读取 Flags
- [ ] 关键功能入口添加 Flag 检查
- [ ] 预留用户级 Flag 覆盖（A/B 测试）

**需要添加 Flag 检查的位置**:
- `src/main/generation/GenerationManager.ts` - Gen8 启用检查
- `src/main/agent/AgentLoop.ts` - maxIterations 检查
- `src/main/tools/gen6/` - computerUse 启用检查

---

### 2.4 Skills 动态化

**修改文件**:
- `src/main/tools/gen4/skill.ts`

**现状**:
```typescript
// skill.ts 中硬编码
const SKILLS: SkillDefinition[] = [
  { name: 'file-organizer', ... },
  { name: 'commit', ... },
  { name: 'code-review', ... },
];
```

**改造后**:
```typescript
// 从 CloudConfigService 读取
const skills = getCloudConfigService().getSkills();
```

**步骤**:
- [ ] 迁移 `SKILLS` 定义到云端 `/api/v1/config`
- [ ] `skill.ts` 改为从 `CloudConfigService.getSkills()` 读取
- [ ] 支持用户自定义 Skill（存本地 SQLite，不上云）
- [ ] Skill 版本管理：云端 Skill 有版本号，本地覆盖时警告

---

### 2.5 工具元数据动态化

**修改文件**:
- `src/main/tools/ToolRegistry.ts`

**现状**: 工具的 `description` 和 `inputSchema` 硬编码在各工具文件中

**改造后**:
- 本地保留 `execute` 执行逻辑
- `description` 和 `inputSchema` 从云端获取
- `ToolRegistry` 初始化时合并云端元数据

**步骤**:
- [ ] 在云端 `toolMeta` 字段添加各工具描述
- [ ] `ToolRegistry.initialize()` 时从 `CloudConfigService` 获取元数据
- [ ] 合并逻辑：云端元数据 > 本地元数据
- [ ] 本地工具版本号检查：云端版本更高时使用云端

---

### 2.6 UI 文案动态化

**新增文件**:
- `src/renderer/hooks/useI18n.ts`
- `src/renderer/i18n/zh.ts`（内置中文）
- `src/renderer/i18n/en.ts`（内置英文）

**步骤**:
- [ ] 创建 `useI18n` hook
- [ ] 优先从云端 `uiStrings` 读取
- [ ] 降级到本地 `i18n/zh.ts` 或 `i18n/en.ts`
- [ ] 提取现有组件中的硬编码文案到 i18n

**示例**:
```typescript
// 组件中使用
const { t } = useI18n();
return <button>{t('common.save')}</button>;
```

---

## 涉及文件汇总

| 操作 | 文件 |
|------|------|
| 新增 | `vercel-api/api/v1/config.ts` |
| 新增 | `src/main/services/cloud/CloudConfigService.ts` |
| 新增 | `src/main/services/cloud/FeatureFlagService.ts` |
| 新增 | `src/main/services/cloud/builtinConfig.ts` |
| 新增 | `src/renderer/hooks/useI18n.ts` |
| 新增 | `src/renderer/i18n/zh.ts` |
| 新增 | `src/renderer/i18n/en.ts` |
| 修改 | `src/main/tools/gen4/skill.ts` |
| 修改 | `src/main/tools/ToolRegistry.ts` |
| 修改 | `vercel-api/api/prompts.ts`（添加重定向）|

---

## 禁止修改

以下文件由其他 Agent 负责：

- `src/main/index.ts`（由 Agent-Refactor 重构）
- `src/main/services/SecureStorage.ts`（由 Agent-Security 修改）
- `package.json` 的 `extraResources`（由 Agent-Security 修改）

---

## 验收标准

- [x] 修改云端 Skill 定义后，客户端重启自动生效
- [x] Feature Flag 关闭 `enableGen8` 后，Gen8 工具不可用
- [x] 网络断开时，使用本地缓存配置，不报错
- [x] 设置页面有「刷新配置」按钮

---

## 交接备注

- **完成时间**: 2025-01-19
- **云端 API 版本**: v1.0.0
- **云端 API 端点**: `https://code-agent-beta.vercel.app/api/v1/config`

### 已实现功能

1. **云端配置中心** (vercel-api/api/v1/config.ts)
   - 统一配置接口，返回 prompts、skills、toolMeta、featureFlags、uiStrings、rules
   - 支持 ETag 缓存控制（304 Not Modified）
   - 支持 `?version=true` 只返回版本号

2. **CloudConfigService** (src/main/services/cloud/CloudConfigService.ts)
   - 单例模式，启动时异步初始化
   - 1 小时缓存 + 过期自动刷新
   - 拉取失败静默降级到内置配置
   - IPC 接口：`CLOUD_CONFIG_REFRESH`、`CLOUD_CONFIG_GET_INFO`

3. **FeatureFlagService** (src/main/services/cloud/FeatureFlagService.ts)
   - 便捷函数：`isGen8Enabled()`、`isComputerUseEnabled()`、`getMaxIterations()`
   - 已在以下位置添加检查：
     - `GenerationManager.ts` - Gen8 启用检查
     - `AgentLoop.ts` - maxIterations 从 Feature Flag 读取
     - `computerUse.ts` - Computer Use 启用检查

4. **Skills 动态化** (src/main/tools/gen4/skill.ts)
   - Skills 定义已迁移到云端
   - 本地通过 `CloudConfigService.getSkills()` 读取

5. **设置页面云端配置 Tab** (src/renderer/components/SettingsModal.tsx)
   - 独立的「云端」Tab 显示配置状态
   - 显示配置版本、来源、缓存状态
   - 支持手动刷新配置

6. **i18n 支持** (src/renderer/i18n/、src/renderer/hooks/useI18n.ts)
   - 内置中英文翻译
   - 支持云端 uiStrings 覆盖

### CloudConfigService API

```typescript
// 获取实例
const service = getCloudConfigService();

// 初始化（应用启动时调用）
await initCloudConfigService();

// 获取配置
service.getPrompt(genId: GenerationId): string
service.getSkills(): SkillDefinition[]
service.getSkill(name: string): SkillDefinition | undefined
service.getToolMeta(name: string): ToolMetadata | undefined
service.getAllToolMeta(): Record<string, ToolMetadata>
service.getFeatureFlags(): FeatureFlags
service.getFeatureFlag(key: keyof FeatureFlags): any
service.getUIString(key: string, lang: 'zh' | 'en'): string
service.getUIStrings(lang: 'zh' | 'en'): Record<string, string>
service.getRule(name: string): string
service.getInfo(): { version, lastFetch, isStale, fromCloud, lastError }

// 刷新
await service.refresh(): Promise<{ success, version, error? }>
```

### 下游 Agent 注意事项

1. **添加新 Feature Flag**:
   - 在 `builtinConfig.ts` 的 `featureFlags` 添加默认值
   - 在 `FeatureFlagService.ts` 添加便捷函数
   - 同步更新云端 `vercel-api/api/v1/config.ts`

2. **添加新 Skill**:
   - 在云端 `config.ts` 的 `skills` 数组添加
   - 或在 `builtinConfig.ts` 添加（离线可用）

3. **修改工具描述**:
   - 修改云端 `config.ts` 的 `toolMeta` 对象

4. **测试离线模式**:
   - 断网后应用应使用内置配置正常工作

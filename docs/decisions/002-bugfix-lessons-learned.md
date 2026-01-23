# ADR-002: v0.10.2 Bug 修复经验总结

> 日期: 2026-01-23
> 状态: 已完成
> 作者: AI Assistant

---

## 背景

v0.10.2 版本进行了一次系统性的 Bug 修复，涉及安全性、稳定性、资源管理和发布流程四个方面。本文档总结这些问题的根因，并提出预防措施。

---

## Bug 分类总结

### 1. 安全性问题

#### 1.1 Math.random() 用于 ID 生成 (28 处)

**问题描述**:
使用 `Math.random().toString(36).substring(2, 9)` 生成 Session ID、Message ID、Task ID 等关键标识符。

**根因分析**:
- `Math.random()` 是伪随机数生成器，可预测
- 在安全敏感场景（如会话标识）使用会带来安全风险
- 开发时图方便，未考虑安全性

**修复方案**:
```typescript
// 修复前
const id = Math.random().toString(36).substring(2, 9);

// 修复后
const id = crypto.randomUUID().split('-')[0]; // 8 字符
```

**预防措施**:
1. **代码规范**: 禁止使用 `Math.random()` 生成任何 ID
2. **ESLint 规则**: 添加自定义规则检测 `Math.random` + `id/Id/ID` 组合
3. **代码审查**: PR 审查时重点检查 ID 生成逻辑
4. **工具函数**: 提供统一的 `generateId()` 函数

```typescript
// src/shared/utils/id.ts
export function generateId(): string {
  return crypto.randomUUID().split('-')[0];
}

export function generateUUID(): string {
  return crypto.randomUUID();
}
```

#### 1.2 JSON.parse 无保护 (2 处需修复)

**问题描述**:
部分 `JSON.parse()` 调用没有 try-catch 保护，解析错误会导致程序崩溃。

**根因分析**:
- 开发时假设输入总是有效 JSON
- 错误处理意识不足
- 部分位置已有 try-catch 但未覆盖所有情况

**修复方案**:
```typescript
// 修复前
const data = JSON.parse(raw);

// 修复后
let data;
try {
  data = JSON.parse(raw);
} catch (error) {
  logger.error('JSON parse error:', error);
  return defaultValue; // 或抛出友好错误
}
```

**预防措施**:
1. **工具函数**: 提供安全的 JSON 解析函数

```typescript
// src/shared/utils/json.ts
export function safeJsonParse<T>(
  raw: string,
  defaultValue: T,
  context?: string
): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.warn(`JSON parse failed${context ? ` (${context})` : ''}:`, error);
    return defaultValue;
  }
}
```

2. **ESLint 规则**: 检测未包装的 `JSON.parse`
3. **类型系统**: 使用 zod/yup 进行运行时类型验证

---

### 2. 前端稳定性问题

#### 2.1 缺少 ErrorBoundary

**问题描述**:
React 渲染错误会导致整个应用白屏，用户无法恢复。

**根因分析**:
- 快速开发时遗漏了错误边界
- 测试环境下错误被忽略
- 缺少生产环境错误处理意识

**修复方案**:
创建 `ErrorBoundary` 组件，包装 App 主内容。

**预防措施**:
1. **项目模板**: 新项目必须包含 ErrorBoundary
2. **检查清单**: 上线前检查是否有错误边界
3. **监控**: 集成错误追踪服务 (Sentry/LogRocket)

#### 2.2 useEffect 计时器泄漏

**问题描述**:
`useCloudTasks` 中 useEffect 的依赖数组包含 useCallback 创建的函数，导致计时器不断重建。

**根因分析**:
- React hooks 依赖追踪复杂
- ESLint exhaustive-deps 规则有时会误导
- 缺少对 hooks 性能影响的理解

**修复方案**:
使用 ref 存储函数引用，避免依赖数组包含函数。

```typescript
// 修复前
useEffect(() => {
  loadTasks();
  const timer = setInterval(loadTasks, interval);
  return () => clearInterval(timer);
}, [loadTasks, interval]); // loadTasks 可能每次都变

// 修复后
const loadTasksRef = useRef(loadTasks);
useEffect(() => {
  loadTasksRef.current = loadTasks;
});

useEffect(() => {
  loadTasksRef.current();
  const timer = setInterval(() => loadTasksRef.current(), interval);
  return () => clearInterval(timer);
}, [interval]); // 只依赖真正需要的值
```

**预防措施**:
1. **代码规范**: 计时器相关 useEffect 必须仔细审查依赖
2. **性能测试**: 定期检查组件重渲染次数
3. **模式文档**: 记录常见 hooks 陷阱和解决方案

---

### 3. 资源管理问题

#### 3.1 MCP 连接超时未清理

**问题描述**:
Promise.race 实现的超时机制，超时后未关闭底层 transport。

**根因分析**:
- Promise.race 的胜出者处理完毕后，失败者仍在执行
- 缺少对异步资源生命周期的管理
- 超时场景测试不充分

**修复方案**:
```typescript
const connectWithTimeout = async (): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    let isSettled = false;

    const timeoutId = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        transport.close().catch(() => {}); // 超时时清理
        reject(new Error('Timeout'));
      }
    }, timeout);

    client.connect(transport)
      .then(() => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutId);
          resolve();
        }
      })
      .catch((err) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
  });
};
```

**预防措施**:
1. **模式库**: 提供标准的超时包装函数
2. **资源追踪**: 关键资源（连接、文件句柄）使用引用计数
3. **测试用例**: 添加超时场景的单元测试

```typescript
// src/shared/utils/timeout.ts
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  cleanup?: () => Promise<void>
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(async () => {
      if (cleanup) await cleanup().catch(() => {});
      reject(new Error(`Operation timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}
```

---

### 4. 发布流程问题

#### 4.1 下载链接仓库地址错误

**问题描述**:
API 中硬编码的下载链接指向错误的 GitHub 仓库。

**根因分析**:
- 复制粘贴时未修改占位符
- 缺少发布前验证步骤
- 配置分散在代码中

**预防措施**:
1. **配置外置**: 仓库地址等配置放入环境变量
2. **发布脚本**: 自动化发布流程

```typescript
// vercel-api/api/update.ts
const GITHUB_REPO = process.env.GITHUB_REPO || 'owner/repo';
const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${filename}`;
```

#### 4.2 文件名格式不一致

**问题描述**:
- 本地文件名: `Code Agent-0.10.2-arm64.dmg` (空格)
- GitHub 存储: `Code.Agent-0.10.2-arm64.dmg` (点)
- API 配置: `Code%20Agent-...` (URL 编码空格)

**根因分析**:
- 未了解 GitHub 的文件名处理规则
- 配置时凭记忆而非验证

**预防措施**:
1. **上传后验证**: 发布脚本上传后自动获取实际 URL
2. **统一命名**: 避免文件名中包含空格
3. **发布检查清单**:
   - [ ] 创建 Git tag
   - [ ] 构建 DMG
   - [ ] 上传到 GitHub Release
   - [ ] **获取实际下载 URL**
   - [ ] 更新 API 配置
   - [ ] 部署 API
   - [ ] **测试下载链接**

```bash
# 发布脚本示例
#!/bin/bash
VERSION=$1

# 1. 创建 release 并上传
gh release create "v$VERSION" \
  --title "Code Agent v$VERSION" \
  "./release/Code Agent-$VERSION-arm64.dmg"

# 2. 获取实际 URL
ACTUAL_URL=$(gh release view "v$VERSION" --json assets \
  | jq -r '.assets[0].url')

echo "实际下载链接: $ACTUAL_URL"
echo "请更新 vercel-api/api/update.ts"
```

---

## 系统性预防措施

### 1. 代码质量

| 措施 | 实现方式 | 优先级 |
|------|----------|--------|
| ESLint 自定义规则 | 检测 Math.random ID、裸 JSON.parse | 高 |
| 工具函数库 | generateId, safeJsonParse, withTimeout | 高 |
| 类型安全 | zod 运行时验证 | 中 |
| 代码模板 | 标准 hooks 模式、错误处理模式 | 中 |

### 2. 测试覆盖

| 场景 | 测试类型 | 优先级 |
|------|----------|--------|
| JSON 解析错误 | 单元测试 | 高 |
| 网络超时 | 集成测试 | 高 |
| 渲染错误恢复 | E2E 测试 | 中 |
| 计时器泄漏 | 性能测试 | 中 |

### 3. 发布流程

```
代码完成 → typecheck → build → 本地测试 →
打包 → 创建 Release → **验证下载链接** →
更新 API → 部署 → **冒烟测试**
```

### 4. 监控告警

- 错误追踪: Sentry 集成
- 性能监控: 内存使用、CPU 占用
- 用户反馈: 应用内反馈渠道

---

## 检查清单模板

### 发布前检查

```markdown
## 代码质量
- [ ] npm run typecheck 通过
- [ ] npm run lint 无新增警告
- [ ] 新增 ID 生成使用 crypto.randomUUID
- [ ] JSON.parse 有 try-catch 保护
- [ ] 异步资源有清理逻辑

## 前端稳定性
- [ ] ErrorBoundary 覆盖主要组件
- [ ] useEffect 依赖数组正确
- [ ] 计时器/监听器有清理

## 发布流程
- [ ] 版本号已更新
- [ ] CHANGELOG 已更新
- [ ] Release 已创建
- [ ] 下载链接已验证 (返回 302)
- [ ] API 已部署
- [ ] 更新功能已测试
```

---

## 总结

| 问题类型 | 数量 | 严重程度 | 预防难度 |
|----------|------|----------|----------|
| 安全性 (ID 生成) | 28 处 | 中 | 低 (工具函数) |
| 安全性 (JSON 解析) | 2 处 | 低 | 低 (工具函数) |
| 前端稳定性 | 2 处 | 中 | 中 (规范+测试) |
| 资源管理 | 1 处 | 低 | 中 (模式库) |
| 发布流程 | 2 处 | 高 | 低 (自动化) |

**核心教训**:
1. 安全和稳定性相关代码需要标准化工具函数
2. 发布流程必须包含验证步骤
3. 异步资源管理需要标准模式

**下一步行动**:
1. 创建 `src/shared/utils/` 工具函数库
2. 添加 ESLint 自定义规则
3. 完善发布脚本自动化

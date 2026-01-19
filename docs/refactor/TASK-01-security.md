# TASK-01: 安全加固

> 负责 Agent: Agent-Security
> 优先级: P0
> 预估时间: 1 周
> 依赖: 无
> 状态: ✅ 已完成

---

## 目标

修复 4 个安全问题，不涉及架构变动。

---

## 任务清单

### 1.1 移除 .env 打包

**问题**: `.env` 文件被打包进应用，API Key 泄露风险

**修改文件**:
- `package.json`

**步骤**:
- [x] 修改 `package.json`，移除 `extraResources` 中的 `.env`
- [x] 添加 `isolated-vm` 到 esbuild external 配置
- [ ] 首次启动时检测 API Key 是否配置，未配置则引导用户到设置页面（延后处理）

**验收**:
```bash
npm run dist:mac
# 检查 /Applications/Code\ Agent.app/Contents/Resources/ 下不存在 .env
```

---

### 1.2 Gen8 tool_create 沙箱

**问题**: 动态创建的工具可执行任意代码，无沙箱隔离

**新增文件**:
- `src/main/tools/evolution/sandbox.ts`

**修改文件**:
- `src/main/tools/gen8/toolCreate.ts`

**步骤**:
- [x] 安装 `isolated-vm` 依赖: `npm install isolated-vm`
- [x] 创建 `src/main/tools/evolution/sandbox.ts`:
  - 禁止 require, import, process, global 等
  - 执行超时 5 秒
  - 内存限制 32MB
- [x] 修改 `toolCreate.ts`，新增 `sandboxed_js` 工具类型
- [x] 增强 `bash_script` 危险命令检测
- [ ] 工具创建前增加用户确认弹窗（延后处理）

**验收**:
```typescript
// 测试恶意代码被拦截
await toolCreate({
  code: `require('fs').unlinkSync('/etc/passwd')`
});
// 应抛出 "禁止访问 require" 错误
```

---

### 1.3 加密存储增强

**问题**: `generateEncryptionKey()` 使用主机名派生密钥，不安全

**修改文件**:
- `src/main/services/SecureStorage.ts`

**步骤**:
- [x] 改用 Electron `safeStorage` 生成加密密钥
- [x] API Keys 存储到系统 Keychain（双重加密）
- [x] 添加 `loadApiKeysFromKeychain()` 启动时加载方法
- [x] 保留 electron-store 作为备份存储

**验收**:
```bash
# macOS 钥匙串中应能看到 Code Agent 相关条目
security find-generic-password -s "Code Agent"
```

---

### 1.4 开发模式安全

**问题**: `devModeAutoApprove` 可自动批准所有操作，风险高

**修改文件**:
- `src/main/services/ConfigService.ts`
- `src/renderer/components/SettingsPanel.tsx`（可选）

**步骤**:
- [x] 生产包中禁用 `devModeAutoApprove`（通过 `app.isPackaged` 判断）
- [x] 添加 `isProduction()` 检测函数
- [x] 添加 `sanitizeForLogging()` 日志脱敏函数
- [x] 添加 `isDevModeAutoApproveEnabled()` 安全访问方法
- [ ] `devModeAutoApprove` 开启时增加二次确认弹窗（延后处理）

**验收**:
- 开发模式开启 `devModeAutoApprove` 时弹出警告
- 打包后的应用设置页面不显示此选项

---

## 涉及文件汇总

| 操作 | 文件 |
|------|------|
| 修改 | `package.json` |
| 新增 | `src/main/tools/evolution/sandbox.ts` |
| 修改 | `src/main/tools/gen8/toolCreate.ts` |
| 修改 | `src/main/services/SecureStorage.ts` |
| 修改 | `src/main/services/ConfigService.ts` |

---

## 禁止修改

以下文件由其他 Agent 负责，本任务禁止修改：

- `src/main/index.ts`（由 Agent-Refactor 重构）
- `vercel-api/` 目录（由 Agent-Cloud 负责）
- `src/main/services/PromptService.ts`（由 Agent-Cloud 废弃）

---

## 交接备注

- **完成时间**: 2025-01-19
- **分支**: `feature/task-01-security`
- **提交数**: 4 个

### 遇到的问题

1. **isolated-vm macOS arm64 兼容性**: 调研发现有 segfault 风险，但实测 32MB 内存限制下正常工作
2. **原生模块打包**: isolated-vm 需要添加到 esbuild external 配置

### 延后处理的功能

1. 首次启动 API Key 检测引导（需要 UI 配合）
2. 工具创建前用户确认弹窗（需要 IPC 通道）
3. devModeAutoApprove 开启时的二次确认弹窗

### 下游 Agent 注意事项

1. **Agent-Refactor**: 在 `index.ts` 初始化时调用 `getSecureStorage().loadApiKeysFromKeychain()`
2. **ConfigService 新 API**: 使用 `isDevModeAutoApproveEnabled()` 代替直接读取 `settings.permissions.devModeAutoApprove`
3. **日志脱敏**: 可使用 `safeLog()` 或 `sanitizeForLogging()` 处理敏感数据

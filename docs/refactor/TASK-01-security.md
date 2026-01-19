# TASK-01: 安全加固

> 负责 Agent: Agent-Security
> 优先级: P0
> 预估时间: 1 周
> 依赖: 无
> 状态: 待执行

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
- [ ] 修改 `package.json`，移除 `extraResources` 中的 `.env`
- [ ] 首次启动时检测 API Key 是否配置，未配置则引导用户到设置页面
- [ ] 更新 `CLAUDE.md` 中的 `.env` 配置说明

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
- [ ] 安装 `isolated-vm` 依赖: `npm install isolated-vm`
- [ ] 创建 `src/main/tools/evolution/sandbox.ts`:
  ```typescript
  // 沙箱配置
  // - 禁止 require, import
  // - 禁止 process, fs, child_process
  // - 执行超时 5 秒
  // - 内存限制 128MB
  ```
- [ ] 修改 `toolCreate.ts`，使用沙箱执行动态代码
- [ ] 工具创建前增加用户确认弹窗（通过 IPC 调用渲染进程）

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
- [ ] 移除 `generateEncryptionKey()` 中基于 hostname 的派生逻辑
- [ ] 改用 Electron `safeStorage.encryptString()` / `decryptString()`
- [ ] Session Token 存储到系统 Keychain
- [ ] 添加迁移逻辑：首次启动时将旧数据迁移到新存储

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
- [ ] `devModeAutoApprove` 开启时增加二次确认弹窗
- [ ] 生产包中禁用此选项（通过 `process.env.NODE_ENV` 判断）
- [ ] 日志中不输出敏感信息（API Key 等），添加脱敏函数

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

_（任务完成后填写）_

- 完成时间:
- 遇到的问题:
- 下游 Agent 注意事项:

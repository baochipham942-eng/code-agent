# Agent-Security 提示词

> 用途：执行 TASK-01 安全加固任务
> 预估时间：1 周
> 可并行：是（与 Agent-Cloud 并行）

---

## 角色设定

你是一个专注于安全加固的开发 Agent。你的任务是修复 Code Agent 项目中的 4 个安全问题，不涉及架构变动。

## 任务文档

请阅读 `docs/refactor/TASK-01-security.md` 获取详细任务清单。

## 工作范围

### 你负责的文件

```
package.json                           # 移除 .env 打包
src/main/tools/evolution/sandbox.ts    # 新增：沙箱隔离
src/main/tools/gen8/toolCreate.ts      # 修改：使用沙箱
src/main/services/SecureStorage.ts     # 修改：使用 safeStorage
src/main/services/ConfigService.ts     # 修改：devModeAutoApprove 安全
```

### 禁止修改的文件

```
src/main/index.ts                      # 由 Agent-Refactor 重构
vercel-api/                            # 由 Agent-Cloud 负责
src/main/services/PromptService.ts     # 由 Agent-Cloud 废弃
```

## 工作流程

1. **阅读任务文档**
   ```
   先阅读 docs/refactor/TASK-01-security.md
   ```

2. **创建分支**
   ```bash
   git checkout -b feature/task-01-security
   ```

3. **逐个完成任务**
   - 1.1 移除 .env 打包
   - 1.2 Gen8 tool_create 沙箱
   - 1.3 加密存储增强
   - 1.4 开发模式安全

4. **验证**
   ```bash
   npm run typecheck
   npm run dev
   npm run dist:mac  # 验证打包产物不含 .env
   ```

5. **提交**
   ```bash
   git add .
   git commit -m "feat(security): 完成安全加固 TASK-01"
   git push origin feature/task-01-security
   ```

6. **更新任务文档**
   在 `TASK-01-security.md` 底部填写交接备注

## 关键技术点

### 沙箱实现 (isolated-vm)

```typescript
import ivm from 'isolated-vm';

const isolate = new ivm.Isolate({ memoryLimit: 128 });
const context = await isolate.createContext();

// 设置超时
const script = await isolate.compileScript(code);
await script.run(context, { timeout: 5000 });
```

### Electron safeStorage

```typescript
import { safeStorage } from 'electron';

// 加密
const encrypted = safeStorage.encryptString(plaintext);

// 解密
const decrypted = safeStorage.decryptString(encrypted);
```

## 验收标准

- [ ] 打包产物不含 .env 文件
- [ ] tool_create 执行恶意代码被拦截
- [ ] API Key 使用 safeStorage 加密存储
- [ ] devModeAutoApprove 在生产包中不可用

## 注意事项

1. 每完成一个子任务就提交，不要积攒
2. 修改 SecureStorage 需要考虑数据迁移
3. 沙箱测试需要覆盖各种恶意代码场景
4. 不要修改任何架构相关代码

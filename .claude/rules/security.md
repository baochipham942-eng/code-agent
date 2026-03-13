---
description: 安全规范 — 密钥管理与硬编码检查
globs: "src/**/*.ts,.env*,**/*.json"
---

# 安全规范

## 密钥管理

- `.env` 通过 tauri.conf.json resources 自动打包，无需手动拷贝
- API Key 不得硬编码在源文件中
- Codex 沙箱和交叉验证功能默认关闭（需环境变量 `CODEX_SANDBOX_ENABLED`, `CROSS_VERIFY_ENABLED` 显式启用）

## 代理配置

- **需要代理**（国际 API）: OpenAI, Anthropic, Google, Groq, xAI — `HTTPS_PROXY=http://127.0.0.1:7897`
- **不需要代理**（国内 API）: 智谱, Kimi, MiniMax, DeepSeek, 火山引擎, 百度, 阿里云
- 系统代理不自动继承到 subprocess，脚本中调国际 API 需显式设置

## 提交前安全自检

```bash
grep -rn "|| 'deepseek'" src/main/ --include="*.ts"
grep -rn "Date.now()" src/main/services/core/repositories/ --include="*.ts"
```

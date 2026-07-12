# 脚本目录约定

`scripts/` 同时服务开发、构建、发布、验收和运维。根层保留稳定入口与历史兼容文件，新增脚本优先进入明确子目录。

| 目录 | 用途 |
|------|------|
| `acceptance/` | 真实 App、浏览器、外部服务和产物闭环验收 |
| `ci/` | GitHub Actions 和本地都可运行的轻量治理门 |
| `perf/` | 性能基线、浏览器 harness 和长会话烟测 |
| `security/`、`pii/` | 安全扫描、敏感信息和 PII 工具链 |
| `observability/` | 监控、dashboard 和 telemetry 运维脚本 |
| `lib/` | 多个脚本复用的无副作用模块 |
| `claude-e2e/` | Claude Code 专属兼容验收 |

## 根层文件保留条件

根层脚本至少满足一项：

- 被 `package.json`、Tauri 配置或多个 workflow 作为稳定入口直接调用；
- 是跨域构建、发布或验证的总编排器；
- 为兼容已发布命令保留固定路径。

一次性迁移、局部调试和新验收脚本不要继续平铺到根层。迁移已有脚本时先保留薄兼容入口，确认 package scripts、workflow 和文档引用全部切换后再删除。

## 命名

- `check-*`：静态检查或治理门，失败应返回非零退出码。
- `verify-*`：验证构建产物、部署或运行合同。
- `*-smoke`：最小可运行链路。
- `build-*`：生成本地或发布产物。
- `release-*` / `publish-*`：正式发布链路，必须可诊断并保持 fail-closed。

仓库结构本身由 `scripts/ci/check-repository-structure.mjs` 校验。

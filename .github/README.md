# GitHub 自动化地图

`.github/workflows/` 只放 GitHub Actions 入口。可复用逻辑优先下沉到 `scripts/`，避免在 YAML 中复制复杂业务规则。

## 工作流分组

| 分组 | 工作流 | 负责什么 |
|------|--------|----------|
| 发布 | `release.yml` | tag 触发的 macOS / Windows 构建、签名、公证和 GitHub Release 发布 |
| Renderer | `renderer-bundle.yml` | renderer capability diff、hot-update smoke、bundle 发布 |
| 平台构建 | `build-windows-test.yml`、`build-x64-test.yml` | Windows 和 Intel macOS 构建验证 |
| Poppler promotion | `build-poppler-sidecar.yml` | 在原生 arm64 / Intel runner 生成待复核的 sidecar、完整源码包和 manifest；不发布、不修改 lock |
| 运行时质量门 | `webserver-boot.yml`、`swarm-ci.yml`、`eval-harness-gate.yml` | webServer 启动、Swarm、评测框架回归 |
| 能力与 provider | `capability-evidence.yml`、`provider-symmetry.yml` | 能力证据和 provider 对称性合同 |
| 云与数据 | `vercel-control-plane.yml`、`supabase-migrate.yml`、`supabase-keepalive.yml` | 控制面部署、数据库迁移和保活 |
| 仓库治理 | `repository-structure.yml` | 导航链接、目录边界和增长 ratchet |

## 维护规则

1. workflow 文件名表达触发对象或交付物，不使用 `ci-2`、`misc` 等无业务含义名称。
2. shell/Node 逻辑超过一个可独立验证步骤时移入 `scripts/`，workflow 只负责权限、环境、缓存和编排。
3. 发布主链新增平台时优先拆 reusable workflow，避免继续扩大 `release.yml`。
4. 新 workflow 必须配置明确的 `paths`、超时和 concurrency；需要写权限时按 job 最小授权。
5. 更新工作流职责时同步更新本页。

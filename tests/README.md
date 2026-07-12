# 测试目录约定

测试按验证层级归档。现有历史目录会渐进收口；新增测试不要再创建新的顶层分类。

| 目录 | 用途 | 命名建议 |
|------|------|----------|
| `unit/` | host、shared、CLI 等纯逻辑和小边界测试；尽量镜像 `src/` 归属 | `*.test.ts(x)` |
| `renderer/` | React 组件、hook、store 和前端交互测试 | `*.test.tsx` |
| `integration/` | 两个以上真实模块协同、持久化或协议集成 | `*.test.ts` |
| `e2e/` | Playwright 和完整用户路径 | `*.spec.ts` |
| `smoke/` | 最小运行链路、环境或打包烟测 | `*.smoke.test.ts` |
| `scripts/` | `scripts/` 下治理、发布和验证脚本的单测 | `*.test.ts` |
| `security/` | 跨模块安全合同和对抗回归 | `*.test.ts` |
| `fixtures/`、`__mocks__/` | 共享测试数据和 mock | 与消费测试同域命名 |
| `manual/` | 必须人工或真实外部环境参与的检查，不进入普通 `npm test` | 文件名写明 live/manual |

## 历史目录

`agent/`、`services/`、`tools/`、`web/`、`shared/`、`channels/` 等顶层目录属于早期按业务域归档的测试。修改这些测试时，若无需大范围改 import，可迁到 `unit/` 下对应领域；不要为了目录整齐单独发起全量搬迁。

## 选择测试层级

1. 单模块规则和回归先放 `unit/`。
2. 需要真实数据库、路由、多个 service 或跨进程契约时放 `integration/`。
3. 需要浏览器和可见用户行为时放 `e2e/`。
4. 真实安装包、外部账号或生产资源验证优先走 `scripts/acceptance/`，不要伪装成普通单测。

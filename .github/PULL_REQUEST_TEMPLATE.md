## Summary

<!-- 1-3 句话说清这个 PR 做了什么、为什么 -->

## Test plan

<!-- 逐条列出跑过的验证：typecheck / eslint-ratchet / knip / targeted 或全量 vitest / E2E 等 -->

## 测试证据

**证据档位**（见 [docs/testing-evidence-classes.md](../docs/testing-evidence-classes.md)，可多选叠加）：

- [ ] static-contract（typecheck / lint / knip 等结构性门）
- [ ] hermetic-protocol（mock 边界下的协议契约单测）
- [ ] fault-injection（变异验证：打断接线确认测试真红，再还原）
- [ ] real-runtime（本地 dogfood 包 / 真实 API / 部署后 smoke）

<!-- 只勾 static-contract + hermetic-protocol 时，说明为什么不需要 fault-injection / real-runtime -->

# Clawdbot 学习计划总览

## 背景

Clawdbot 是一款开源、自托管的个人 AI 助手，在以下方面做得比 Code Agent 更好：

| 短板 | 优先级 | 复杂度 | 依赖 |
|------|--------|--------|------|
| 1. 本地化（sqlite-vec + 多 Embedding） | P1 | 高 | 无 |
| 2. 增量同步（文件 watcher） | P1 | 中 | #1 |
| 3. 配置级 Agent 路由 | P2 | 中 | 无 |
| 4. PTY 伪终端 | P0 | 中 | 无 |
| 5. 多通道接入（飞书优先） | P2 | 高 | #3 |
| 6. Heartbeats/Cron | P1 | 中 | 无 |
| 7. Skill 系统 | P2 | 高 | 无 |

## 推荐实现顺序

```
Phase 1: 基础能力
├── 4. PTY 伪终端（无依赖，立即可做）
├── 1. 本地化（sqlite-vec）
└── 2. 增量同步（依赖 #1）

Phase 2: 自动化
├── 6. Heartbeats/Cron
└── 3. 配置级 Agent 路由

Phase 3: 生态扩展
├── 7. Skill 系统
└── 5. 多通道接入
```

## 设计文档索引

- [01-pty-terminal.md](./01-pty-terminal.md) - PTY 伪终端支持
- [02-local-vector-store.md](./02-local-vector-store.md) - 本地向量存储
- [03-incremental-sync.md](./03-incremental-sync.md) - 增量同步机制
- [04-agent-routing.md](./04-agent-routing.md) - 配置级 Agent 路由
- [05-heartbeats-cron.md](./05-heartbeats-cron.md) - 定时任务系统
- [06-skill-system.md](./06-skill-system.md) - Skill 技能系统
- [07-multi-channel.md](./07-multi-channel.md) - 多通道接入

## Clawdbot 源码参考

仓库：https://github.com/clawdbot/clawdbot

| 模块 | 路径 | 文件数 | 说明 |
|------|------|--------|------|
| Memory | `src/memory/` | 35 | 向量存储、Embedding、混合搜索 |
| Browser | `src/browser/` | 70 | 浏览器控制、CDP、Playwright |
| Cron | `src/cron/` | 23 | 定时任务、Heartbeat |
| Channels | `src/channels/` | 33 | 通道抽象、路由 |
| Routing | `src/routing/` | 6 | Agent 路由规则 |
| Skills | `skills/` | 52 | 技能定义 |
| Agents | `src/agents/` | 294 | Agent 核心、bash 工具、PTY |

## 验收标准

每个功能完成后需要：
1. 功能可用：核心场景跑通
2. 有测试覆盖
3. 文档更新（CLAUDE.md）
4. 无明显性能退化

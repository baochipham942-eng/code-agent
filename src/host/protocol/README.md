# Protocol Layer

主进程内部协议中介层。参考 Codex `codex-protocol` crate + Claude Code Agent SDK 的 AsyncIterable 消息流设计。

## 为什么存在

对比 Codex（Rust 零循环依赖）和 CodePilot（TS 9 条循环）后得出的结论：TS Electron Agent 想消除 agent↔tools↔services 的循环依赖，必须建一个**类型中介层**，让业务代码通过它解耦，而不是互相直接 import 类型。

本目录就是这个中介层。

## 规则

1. **main 侧 only**。这里放的是主进程内部协议（EventBatcher 事件、Tool Schema、Subagent Op/Submission 等）。
2. **跨进程共享类型不放这里**，放 `src/shared/contract/`（给 renderer 和 main 同时用）。
3. **只放类型和常量**，不放运行时逻辑。一个文件要么是 `export interface/type/enum/const`，要么不该进 protocol。
4. **禁止反向依赖**：protocol/ 不得 import `../agent`、`../tools`、`../services`、`../ipc`、`../context`。只能从 `../../shared/contract` 和第三方类型包引入。
5. **跨模块类型引用优先走 protocol**。新代码如果需要在 agent/tools/services 之间共享类型，第一选择是定义在 protocol/ 里。

## 目录布局

```
protocol/
├── events.ts       // Agent 事件 discriminated union + CC 16 hook event 语义
├── types/          // 从 services/agent/tools 抽出来的 main-only 类型
│   ├── git.ts      // FileChangeEvent 等
│   ├── github.ts   // PRContext / ParsedPRUrl 等
│   └── ...
├── index.ts        // 统一导出
└── README.md
```

## 对应 Codex 的设计

| Codex Rust            | 本项目 TS                |
|-----------------------|-------------------------|
| `codex-protocol` crate| `src/main/protocol/`    |
| `EventMsg` enum       | `AgentEvent` union      |
| `Op` enum             | 待建（P0-5+）             |
| `Submission` struct   | 待建（P0-5+）             |
| `codex-tools` crate Schema | 待建（P0-5+）        |

## 验收

每次改动后跑：

```bash
npx madge --ts-config tsconfig.json --extensions ts,tsx --circular src/main
npx madge --ts-config tsconfig.json --extensions ts,tsx src/main --json > /tmp/madge.json
npm run typecheck
```

循环依赖数 ≤ 4，services 目录 fan-in 不升反降。

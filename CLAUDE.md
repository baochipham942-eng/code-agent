# Code Agent

AI 编程助手桌面应用，用于学习和研究 AI Agent 能力演进。

## 项目简介

这是一个基于 Electron + React 的桌面应用，通过复刻 Claude Code 的 4 个架构代际来观察和学习 AI Agent 能力的演进过程。

## 技术栈

- **框架**: Electron 33 + React 18
- **语言**: TypeScript 5.6
- **构建**: esbuild (main/preload) + Vite (renderer)
- **样式**: Tailwind CSS 3.4
- **状态管理**: Zustand 5
- **AI 模型**: DeepSeek API (主要)，支持 OpenAI/Claude 切换

## 目录结构

```
src/
├── main/                  # Electron 主进程
│   ├── index.ts          # 入口，窗口创建
│   ├── agent/            # Agent 核心
│   │   ├── AgentOrchestrator.ts  # 编排器
│   │   └── AgentLoop.ts          # 事件循环
│   ├── generation/       # 代际管理
│   │   └── GenerationManager.ts
│   ├── model/            # 模型路由
│   │   └── ModelRouter.ts
│   ├── tools/            # 工具实现
│   │   ├── gen1/         # bash, read_file, write_file, edit_file
│   │   ├── gen2/         # glob, grep, list_directory
│   │   ├── gen3/         # task, todo_write, ask_user_question
│   │   └── gen4/         # skill, web_fetch
│   └── services/         # 配置服务
├── preload/              # 预加载脚本
├── renderer/             # React 前端
│   ├── components/       # UI 组件
│   ├── hooks/            # 自定义 hooks
│   └── stores/           # Zustand 状态
└── shared/               # 共享类型和 IPC 定义
```

## 4 代工具演进

| 代际 | 版本 | 工具集 | 核心能力 |
|------|------|--------|----------|
| Gen 1 | v0.2 Beta | bash, read_file, write_file, edit_file | 基础文件操作 |
| Gen 2 | v1.0 | + glob, grep, list_directory | 搜索和导航 |
| Gen 3 | v1.0.60 | + task, todo_write, ask_user_question | 子代理和规划 |
| Gen 4 | v2.0 | + skill, web_fetch | 技能系统和网络 |

## 常用命令

```bash
# 开发模式
npm run dev

# 构建
npm run build

# 启动（构建后）
npm run start

# 打包 macOS 应用
npm run dist:mac

# 类型检查
npm run typecheck
```

## 环境变量

项目使用 `.env` 文件配置 API：
- `DEEPSEEK_API_KEY` - DeepSeek API 密钥
- `DEEPSEEK_API_URL` - DeepSeek API 地址

## 开发要点

1. **IPC 通信**: 主进程和渲染进程通过 `src/shared/ipc.ts` 定义的类型安全通道通信
2. **Agent 循环**: `AgentLoop.ts` 实现核心推理循环：用户输入 → 模型推理 → [工具调用]* → 响应
3. **代际切换**: 通过 `GenerationManager` 切换不同代际，动态加载对应的工具集和 system prompt
4. **工具权限**: `ToolExecutor` 控制危险操作的权限检查

## 相关文档

- [产品需求文档](docs/PRD.md)
- [架构设计文档](docs/ARCHITECTURE.md)

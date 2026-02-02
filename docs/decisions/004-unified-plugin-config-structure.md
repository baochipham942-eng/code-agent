# ADR-004: 统一插件配置目录结构

> 状态: proposed
> 日期: 2026-02-02

## 背景

当前 code-agent 的扩展配置分散在多处：
- Hooks 配置在 `.claude/settings.json`
- Skills 通过目录扫描发现
- Plugins 放在 `~/.config/code-agent/plugins/`
- MCP 配置方式不统一

参考 Claude Code 的插件系统设计（`.claude-plugin/` 统一目录），我们需要优化配置结构以提升：
1. 开发者体验（DX）
2. 团队协作友好性
3. 配置可发现性

## 决策

采用 **统一 `.code-agent/` 配置目录** 方案，将项目级扩展配置集中管理。

### 目标目录结构

```
项目根目录/
└── .code-agent/                    # 统一配置目录
    ├── settings.json               # 用户个人设置（建议 gitignore）
    ├── hooks/
    │   ├── hooks.json              # Hook 注册表
    │   └── scripts/                # Hook 脚本
    │       ├── pre-bash-validate.sh
    │       └── post-edit-lint.js
    ├── skills/                     # 项目级技能定义
    │   └── deploy.yaml
    ├── agents/                     # 自定义 Agent 配置
    │   └── custom-reviewer.yaml
    └── mcp.json                    # MCP 服务器配置
```

### hooks.json 格式

```json
{
  "$schema": "https://code-agent.dev/schemas/hooks.json",
  "PreToolUse": [
    {
      "matcher": "bash",
      "hooks": [
        {
          "type": "command",
          "command": "./.code-agent/hooks/scripts/pre-bash-validate.sh",
          "timeout": 5000
        }
      ]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "edit_file",
      "hooks": [{ "type": "command", "command": "npm run lint --fix" }]
    }
  ]
}
```

### 新增 CLI 命令

```bash
# 插件安装（P0 优先级）
code-agent plugin install <name>      # 从官方源安装
code-agent plugin install ./local-dir # 本地安装
code-agent plugin list                # 列出已安装插件
code-agent plugin remove <name>       # 卸载插件

# 初始化项目配置
code-agent init                       # 创建 .code-agent/ 目录结构
```

## 选项考虑

### 选项 1: 保持现状（分散配置）

- 优点: 无需迁移，向后兼容
- 缺点:
  - 配置分散，新人难以发现
  - hooks 和个人设置混在一起，不利于团队共享
  - 无法安全地将项目级 hooks 提交到 git

### 选项 2: 统一 `.code-agent/` 目录（采纳）

- 优点:
  - 单一职责：hooks、skills、agents 各自独立
  - 团队协作友好：项目级配置可提交，个人设置可 gitignore
  - 自文档化：目录结构即文档
  - 与 Claude Code 设计理念一致
- 缺点:
  - 需要迁移现有配置
  - 需要同时支持新旧配置路径（过渡期）

### 选项 3: 完全照搬 `.claude-plugin/` 结构

- 优点: 与 Claude Code 完全兼容
- 缺点:
  - 命名与项目品牌不一致
  - 缺少我们已有的高级特性（热加载、权限隔离）

## 实施计划

### P0（体验提升大，工作量小）

| 任务 | 描述 | 预计改动 |
|------|------|----------|
| 统一配置目录 | 支持 `.code-agent/` 作为配置根目录 | ConfigService |
| hooks.json 分离 | hooks 配置从 settings.json 移到独立文件 | HooksService |
| 向后兼容 | 同时支持旧路径，优先读取新路径 | 配置加载逻辑 |

### P1（中等收益）

| 任务 | 描述 | 预计改动 |
|------|------|----------|
| `/plugin install` 命令 | CLI 安装插件 | CLI 模块 |
| JSON Schema | 为 hooks.json、mcp.json 提供 schema | 新增 schemas/ |
| `code-agent init` | 初始化项目配置目录 | CLI 模块 |

### P2（锦上添花）

| 任务 | 描述 |
|------|------|
| 官方插件源 | 建立 `@code-agent-plugins` 官方仓库 |
| 插件版本管理 | 支持版本锁定和升级策略 |
| 配置迁移工具 | 自动迁移旧配置到新结构 |

## 后果

### 积极影响

- 配置结构清晰，开发者体验提升
- 项目级 hooks/skills 可安全提交到 git
- 与 Claude Code 生态理念对齐，降低用户学习成本
- 为未来插件市场打下基础

### 消极影响

- 需要维护新旧配置路径的兼容逻辑
- 现有用户需要迁移配置（提供迁移工具）

### 风险

- 迁移期间可能有配置读取混乱（缓解：明确优先级，新路径 > 旧路径）
- 用户可能同时在两处配置 hooks（缓解：检测并警告）

## 相关文档

- [Claude Code Plugin System](https://docs.anthropic.com/claude-code/plugins)（参考设计）
- [架构概览](../architecture/overview.md)
- [工具系统](../architecture/tool-system.md)

# 创建 PR 工作流

1. 运行 `tsc --noEmit` 并修复所有类型错误
2. 运行已修改文件的现有测试
3. 如果尚未在特性分支上，创建描述性分支名
4. 暂存并提交所有变更，使用规范的提交消息
5. 推送分支并创建到 main 的 PR，附带变更摘要
6. 报告 PR URL

## 构建验证（PR 前检查）

| 变更范围 | 验证命令 |
|----------|----------|
| `src/renderer/` | `npm run build:web` |
| `src-tauri/` | `cargo tauri build --debug` |
| `src/main/` | `npm run build && cargo tauri build --debug` |
| `package.json` 版本 | `npm run build && npm run build:web && cargo tauri build` |

- Tauri 构建需要 Rust 工具链: `PATH="$HOME/.cargo/bin:$PATH"`
- DMG 产物: `src-tauri/target/release/bundle/dmg/Code Agent_*.dmg` (~33MB)

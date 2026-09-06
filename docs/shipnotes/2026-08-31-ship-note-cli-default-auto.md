# Ship Note — chat/TTY 默认权限档改为 auto

日期：2026-08-31
分支：feat/cli-default-auto

## 背景

#1516 StatusBar 左侧显示 `ask`（每条都弹审批卡）。用户要求默认改成 auto。

## 改动

- `neo chat` / 裸 `neo` 默认 `--permission-mode auto`。`--permission-mode ask` 恢复旧行为。
- TTY auto：分类器判安全的操作直接 `cli-auto-approve`，不再弹卡；其余仍走审批卡。
- headless `neo run` 默认不变（不加 flag 仍 fail-closed）。
- StatusBar 左侧默认显示 `auto`。

## 验证

- permissionPolicy 单测：auto 放行安全命令不弹卡、危险命令交给审批卡、ask 标志、headless fail-closed。
- typecheck / build:cli / eslint / knip。

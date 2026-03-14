# Reminders Connector 真机验收

## 目标

验证 Reminders connector 在真实 macOS Reminders 环境中可完成 create / update / delete 全链路。

## 前置条件

- macOS Reminders 可正常打开。
- 建议先创建一个专用测试列表，例如 `Code Agent Acceptance`。

## 验收步骤

### 1. 状态与列表

```bash
npm run acceptance:reminders -- status
npm run acceptance:reminders -- lists
```

确认测试列表存在。

### 2. 创建提醒

```bash
npm run acceptance:reminders -- create \
  --list "Code Agent Acceptance" \
  --title "Reminders acceptance item" \
  --notes "created by smoke test"
```

记录返回的 `id`。

确认：

- 测试列表中出现该 reminder

### 3. 更新提醒

```bash
npm run acceptance:reminders -- update \
  --list "Code Agent Acceptance" \
  --reminder-id "<id>" \
  --title "Reminders acceptance item updated" \
  --completed true
```

确认：

- 标题更新成功
- completed 状态更新成功

### 4. 删除提醒

```bash
npm run acceptance:reminders -- delete \
  --list "Code Agent Acceptance" \
  --reminder-id "<id>"
```

确认：

- reminder 被删除
- 测试列表恢复干净

## 通过标准

- `status` / `lists` 成功。
- create / update / delete 全成功。
- 测试数据仅落在专用测试 list。

## 风险提示

- 不要在正式工作清单中直接验收删除。
- 所有测试 reminder 必须使用专用测试 list。

## 失败记录模板

| 日期 | 步骤 | 现象 | Reminders 侧表现 | 是否阻塞上线 |
|------|------|------|------------------|--------------|
|      |      |      |                  |              |

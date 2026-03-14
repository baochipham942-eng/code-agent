# Calendar Connector 真机验收

## 目标

验证 Calendar connector 在真实 macOS Calendar 环境中可完成 create / update / delete 全链路。

## 前置条件

- macOS Calendar 可正常打开。
- 建议先创建一个专用测试日历，例如 `Code Agent Acceptance`。

## 验收步骤

### 1. 状态与日历列表

```bash
npm run acceptance:calendar -- status
npm run acceptance:calendar -- calendars
```

确认测试日历存在。

### 2. 创建测试事件

```bash
npm run acceptance:calendar -- create \
  --calendar "Code Agent Acceptance" \
  --title "Calendar acceptance event" \
  --start-ms 1760000000000 \
  --end-ms 1760001800000 \
  --location "Smoke Test"
```

记录返回的 `uid`。

确认：

- Calendar 中出现该事件
- 标题、时间、地点正确

### 3. 更新测试事件

```bash
npm run acceptance:calendar -- update \
  --calendar "Code Agent Acceptance" \
  --event-uid "<uid>" \
  --title "Calendar acceptance event updated" \
  --location "Updated Smoke Test"
```

确认：

- Calendar 中该事件被更新

### 4. 删除测试事件

```bash
npm run acceptance:calendar -- delete \
  --calendar "Code Agent Acceptance" \
  --event-uid "<uid>"
```

确认：

- 事件被删除
- 测试日历恢复干净状态

## 通过标准

- `status` / `calendars` 成功。
- create / update / delete 全成功。
- 测试数据仅留在专用测试日历。

## 风险提示

- 不要在正式工作日历上直接做删除验收。
- 所有测试事件必须使用专用测试 calendar。

## 失败记录模板

| 日期 | 步骤 | 现象 | Calendar 侧表现 | 是否阻塞上线 |
|------|------|------|-----------------|--------------|
|      |      |      |                 |              |

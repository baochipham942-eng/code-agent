# Native Desktop 真机验收

## 目标

验证原生桌面 collector 在真实 macOS 机器上可持续采集，并且 JSONL / SQLite / 脱敏行为符合预期。

## 前置条件

- 运行环境为 macOS。
- 已构建并启动桌面应用。
- 已授予：
  - Accessibility
  - Screen Recording
- 应用设置页中的“原生桌面底座”可见。

## 验收步骤

### 1. 权限与基础状态

在设置页确认：

- platform 为 `macos`
- frontmost context 可用
- background collection 可用
- permission snapshot 中 Accessibility / Screen Capture 已授权

### 2. 启动 collector

在设置页点击“启动采集”，确认：

- collector 状态变为 `running`
- `eventDir` / `sqliteDbPath` / `screenshotDir` 都有值
- `lastError` 为空

### 3. 手动制造活动样本

建议连续操作 10 到 15 分钟：

- 打开浏览器并访问至少两个站点
- 打开一个本地文件
- 切换到 Terminal / Cursor / Finder 等不同应用
- 保持一段 idle，再恢复操作
- 如有条件，锁屏后再解锁一次

### 4. 运行 smoke 脚本

```bash
npm run acceptance:native-desktop -- --require-running true --freshness-minutes 15
```

若使用自定义数据目录：

```bash
npm run acceptance:native-desktop -- --root ~/.code-agent/native-desktop
```

### 5. 检查 recent events

在设置页 Recent Events 中确认：

- 能看到刚才访问的应用和页面
- 至少有一条带 URL 的浏览器事件
- 至少有一条带 document path 的文档事件
- session / power 字段有值

### 6. 检查截图与脱敏

验证：

- 非敏感上下文有截图路径
- 敏感上下文不会泄露 URL / document / window title
- 若切到密码类应用，截图不应记录真实敏感内容

### 7. 检查 retention

把 retention 调低后重新运行一轮，确认：

- 旧 JSONL 被清理
- 旧截图被清理
- SQLite 旧记录被清理

## 通过标准

- smoke 脚本返回成功。
- `collector-status.json`、`events/*.jsonl`、`desktop-activity.sqlite3` 都存在。
- 最新事件时间在可接受新鲜度内。
- 最近事件能够对应到人工操作轨迹。
- 脱敏行为正确。

## 失败记录模板

| 日期 | 现象 | 复现步骤 | 影响范围 | 是否阻塞理解层 |
|------|------|----------|----------|----------------|
|      |      |          |          |                |

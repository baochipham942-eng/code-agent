# Mail Connector 真机验收

## 目标

验证 Mail connector 在真实 macOS Mail 环境中可完成状态检查、草稿创建、附件草稿和真实发送。

## 前置条件

- macOS Mail 已完成至少一个账号登录。
- 准备一个自测邮箱地址，建议发给自己。
- 如要测附件，准备一个小体积测试文件。

## 验收步骤

### 1. 状态检查

```bash
npm run acceptance:mail -- status
npm run acceptance:mail -- accounts
npm run acceptance:mail -- mailboxes
```

确认：

- 能返回账户列表
- 能返回 mailbox 列表

### 2. 创建普通草稿

```bash
npm run acceptance:mail -- draft \
  --subject "Code Agent acceptance draft" \
  --to "your-self@example.com" \
  --content "This is a local draft smoke test."
```

确认：

- Mail 中出现一封新草稿
- 主题、收件人、正文正确

### 3. 创建带附件草稿

```bash
npm run acceptance:mail -- draft \
  --subject "Code Agent acceptance draft with attachment" \
  --to "your-self@example.com" \
  --content "Attachment smoke test." \
  --attachments "/absolute/path/to/file.txt"
```

确认：

- 草稿存在
- 附件真实挂载

### 4. 真实发送

```bash
npm run acceptance:mail -- send \
  --subject "Code Agent acceptance send" \
  --to "your-self@example.com" \
  --content "This is a real send smoke test."
```

确认：

- 终端返回发送成功
- 收件箱收到邮件
- 已发送中存在该邮件

## 通过标准

- `status` / `accounts` / `mailboxes` 成功。
- 普通草稿成功。
- 附件草稿成功。
- 真实发送成功并在收件箱、已发送中可见。

## 风险提示

- 真实 `send` 会发信，不要用正式外部收件人。
- 附件请使用测试文件，不要发送敏感文件。

## 失败记录模板

| 日期 | 命令 | 失败现象 | Mail 侧表现 | 是否阻塞上线 |
|------|------|----------|-------------|--------------|
|      |      |          |             |              |

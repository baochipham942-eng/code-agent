# Code Agent 自动化测试报告

**生成时间**: 2026/03/03 21:36:48
**运行 ID**: `67120cc6-a275-486e-a91a-24ba764353e8`

## 概览

| 指标 | 值 |
|------|-----|
| 总用例数 | 9 |
| 通过 | 2 ✅ |
| 失败 | 7 ❌ |
| 跳过 | 0 ⏭️ |
| 通过率 | 22.2% |
| 总耗时 | 2m 24s |

### 进度

`[█████████▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓]` 22.2%

## 环境信息

| 配置 | 值 |
|------|-----|
| 代际 | gen8 |
| 模型 | kimi-k2.5 |
| 提供商 | moonshot |
| 工作目录 | `/Users/linchen/Downloads/ai/code-agent` |

## 失败用例详情

### ❌ bash-ls

**描述**: bash 工具 - 列出目录

**失败原因**: Expected tool matching "bash" to be called

**断言详情**:
```json
{
  "expected": [
    "bash"
  ],
  "actual": [
    []
  ],
  "assertion": "tool"
}
```

---

### ❌ bash-pwd

**描述**: bash 工具 - 显示当前路径

**失败原因**: Test timeout after 30000ms

**错误日志**:
```
Test timeout after 30000ms
```

---

### ❌ bash-echo

**描述**: bash 工具 - 输出文本

**失败原因**: Expected tool matching "bash" to be called

**断言详情**:
```json
{
  "expected": [
    "bash"
  ],
  "actual": [
    []
  ],
  "assertion": "tool"
}
```

---

### ❌ read-file-exists

**描述**: read_file 工具 - 读取存在的文件

**失败原因**: Expected tool matching "read_file" to be called

**断言详情**:
```json
{
  "expected": [
    "read_file"
  ],
  "actual": [
    []
  ],
  "assertion": "tool"
}
```

---

### ❌ write-file-new

**描述**: write_file 工具 - 创建新文件

**失败原因**: Expected tool matching "write_file" to be called; Expected file "test-write-temp.txt" to be created; Cannot check content - file "test-write-temp.txt" not found

**断言详情**:
```json
{
  "expected": [
    "write_file",
    "test-write-temp.txt",
    "test-write-temp.txt"
  ],
  "actual": [
    [],
    "file not found",
    "file not found"
  ],
  "assertion": "tool, files_created, file_contains"
}
```

---

### ❌ edit-file-modify

**描述**: edit_file 工具 - 修改现有文件

**失败原因**: Test timeout after 30000ms

**错误日志**:
```
Test timeout after 30000ms
```

---

### ❌ glob-find-ts

**描述**: glob 工具 - 查找 TypeScript 文件

**失败原因**: Test timeout after 30000ms

**错误日志**:
```
Test timeout after 30000ms
```

---

## 通过用例

| 用例 ID | 描述 | 耗时 | 工具调用数 |
|---------|------|------|-----------|
| ✅ read-file-not-exists | read_file 工具 - 读取不存在的文件 | 13.2s | 1 |
| ✅ grep-search | grep 工具 - 搜索代码 | 14.6s | 4 |

## 性能统计

| 指标 | 值 |
|------|-----|
| 平均响应时间 | 16.0s |
| 最长响应时间 | 30.0s |
| 总工具调用数 | 5 |
| 总对话轮数 | 6 |

### 最慢用例 (Top 5)

| 排名 | 用例 ID | 耗时 |
|------|---------|------|
| 1 | edit-file-modify | 30.0s |
| 2 | bash-pwd | 30.0s |
| 3 | glob-find-ts | 30.0s |
| 4 | grep-search | 14.6s |
| 5 | read-file-not-exists | 13.2s |

## 建议

1. 检查工具实现：bash-ls, bash-echo, read-file-exists, write-file-new 测试中工具执行失败
2. 检查文件操作：write-file-new 测试中文件断言失败
3. 考虑增加超时时间或优化响应速度：3 个测试超时
4. 优化响应时间：3 个测试耗时超过 30 秒

---

*此报告由 Code Agent 自动化测试框架生成*
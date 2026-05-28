# Swarm-JSONL Dogfood Log

> file 模式(`CODE_AGENT_SWARM_STORAGE=file`)的真活观察记录。每次跑遇到问题/想到改进点,就往下面追加一条。
> 不写"还行"这种空记录;有具体观察 / 现象 / 数字才写。

PR-1: https://github.com/baochipham942-eng/code-agent/pull/172
PR-2: https://github.com/baochipham942-eng/code-agent/pull/173

---

## Entry 模板

```markdown
### YYYY-MM-DD — <一句话标题>
- **环境**:webServer / CLI;模型 + provider
- **触发**:一段简述 / 完整 prompt
- **JSONL 现状**:`<file path>` 大小 / entry 数 / 4 种类型是否齐全
- **观察 / 现象**:贴 RAW 输出片段
- **问题**:✅ / ⚠️ / ❌ + 一句话定性
- **action**:Patch / 等观察 / 升级到 issue
```

---

## 观察清单(每次跑可以扫一遍)

- [ ] jsonl 文件名格式对(`<YYYY-MM-DDTHHmmss>__<runId>.jsonl`)
- [ ] 4 种 entry 都出现:`run_started` / `agent_upserted` / `event` / `run_closed`
- [ ] `agent_upserted` 末状态对得上 IPC `getRunDetail` 拿回的 agent 状态
- [ ] `event[].seq` 单调递增,无跳号
- [ ] payload 没看到 `_truncated`(除非确实超 8KB)
- [ ] 文件大小符合预期(~2KB/event 平均)
- [ ] `~/.code-agent/swarm-runs/` 目录文件数堆积是否合理(超 100 个考虑加 listRuns 性能优化)
- [ ] CLI 模式跑通(`CODE_AGENT_SWARM_STORAGE=file node dist/cli/index.cjs exec ...`)

---

## 已知性能/UX 边界(预期会遇到)

| 边界 | 触发条件 | 处理 |
|---|---|---|
| `MAX_EVENTS_PER_RUN=2000` | 单 run >2000 timeline 事件 | 尾部丢弃,head 保留(reproducer 友好) |
| `MAX_EVENT_PAYLOAD_BYTES=8KB` | 单 payload >8KB | 截 + `_truncated` marker |
| listRuns 性能 | 目录文件数 >200 | 当前是 O(N) readdir + 每文件 read,极端时考虑加 mtime LRU cache |
| 半行崩溃 | 进程中断时 kernel 没刷完 | 新实例 probe \n 自愈,半行 JSON.parse 跳过 |

---

## 记录区(按时间倒序)

<!-- 新记录加到这下面 -->
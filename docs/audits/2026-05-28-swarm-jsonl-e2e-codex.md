# Swarm JSONL E2E Acceptance — 2026-05-28
Branch: feat/swarm-trace-jsonl @ 3b5c655f
Acceptor: Codex

## Verdict: PARTIAL

A/B/C pass with real webServer + real `/api/run` + real IPC/file/SQLite readback. D fails: the requested CLI command `node dist/cli/index.cjs exec ...` is not registered, so no CLI JSONL file is produced.

Notes:
- DeepSeek was tried first and returned `Insufficient Balance`; MiMo (`provider=xiaomi`, `model=mimo-v2.5-pro`) was used for the passing webServer runs.
- The webServer's actual default DB path in this worktree is `~/.code-agent/code-agent.db`. The task's `~/Library/Application Support/code-agent/code-agent.db` exists but has no `swarm_runs` table, so I checked both and call this out explicitly.
- A file-mode first attempt did not call `AgentSpawn`; it used `TaskManager`/direct tools and produced no JSONL. The passing B run used a stricter prompt that forced `ToolSearch select:AgentSpawn` before `AgentSpawn`.

## A. SQL 默认无回归

- 命令:
```bash
env -u CODE_AGENT_SWARM_STORAGE CODE_AGENT_E2E=1 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 npm run dev:web:server 2>&1 | tee /tmp/swarm-jsonl-sql-server.log
```
- 输出:
```text
> code-agent@0.16.88 dev:web:server
> npm run build:web && node dist/web/webServer.cjs

> code-agent@0.16.88 build:web
> npm_config_cache=/tmp/code-agent-npm-cache npx tsx esbuild.config.ts web

Building 1 target(s)...
  ✓ Control plane public keys → dist/web/control-plane-public-keys.json (0 key(s))
  ✓ Web Server → dist/web/webServer.cjs (1178ms)
Done.
[1/3] Initializing backend services...
2026-05-28T09:01:55.894Z INFO [WebServer] Database initialized
[2/3] Registering IPC handlers...
2026-05-28T09:01:55.910Z DEBUG [SwarmTraceWriter] SwarmTraceWriter installed
2026-05-28T09:01:55.910Z INFO [WebServer] SwarmServices registered for web mode
[3/3] Starting HTTP server...

{"port":8180,"token":"1ea4ba16-0508-4630-9627-efaf8defb408"}

  API server:  http://127.0.0.1:8180
  Health:      http://127.0.0.1:8180/api/health
  SSE Events:  http://127.0.0.1:8180/api/events
  Auth token:  1ea4ba16...
```

- 命令:
```bash
TOKEN=$(cat .dev-token)
PROMPT="E2E acceptance for swarm trace. You must use the AgentSpawn tool, parallel=true, with exactly two agents. Agent 1 role=explore task='List all files under src/main/agent and summarize count only; do not edit files.' Agent 2 role=coder task='Write the exact text hello to /tmp/swarm-e2e-test-sql.txt; do not touch the repository.' Wait for both agents to finish, then reply with a short summary. Do not solve this directly yourself."
BODY=$(jq -nc --arg prompt "$PROMPT" '{prompt:$prompt,project:"/tmp/swarm-e2e",sessionId:"e2e-sql-codex-20260528-mimo",provider:"xiaomi",model:"mimo-v2.5-pro"}')
timeout 900 curl -sS -N -X POST http://localhost:8180/api/run -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$BODY" -o /tmp/swarm-jsonl-a-sql-mimo.sse -w 'curl_http_code=%{http_code}\nbytes_downloaded=%{size_download}\ntime_total=%{time_total}\n'
```
- 输出:
```text
curl_http_code=200
bytes_downloaded=61534
time_total=170.804629
```

- 命令:
```bash
FILE=/tmp/swarm-jsonl-a-sql-mimo.sse node - <<'NODE'
const fs = require('fs');
const lines = fs.readFileSync(process.env.FILE, 'utf8').split(/\n/);
let event = null;
for (const line of lines) {
  if (line.startsWith('event: ')) {
    event = line.slice(7);
    continue;
  }
  if (!line.startsWith('data: ')) continue;
  let data;
  try { data = JSON.parse(line.slice(6)); } catch { continue; }
  if (event === 'tool_call_start' && (data.name === 'AgentSpawn' || data.name === 'ToolSearch')) {
    const args = data.arguments || {};
    console.log(`${event} name=${data.name} parallel=${args.parallel ?? ''} agents=${Array.isArray(args.agents) ? args.agents.length : ''} query=${args.query ?? ''}`);
  }
  if (event === 'tool_call_end' && typeof data.output === 'string' && data.output.includes('AgentSpawn')) {
    console.log(`${event} loaded_AgentSpawn success=${data.success}`);
  }
  if (event === 'agent_complete') console.log('agent_complete');
}
NODE
```
- 输出:
```text
tool_call_start name=ToolSearch parallel= agents= query=select:AgentSpawn
tool_call_end loaded_AgentSpawn success=true
tool_call_start name=AgentSpawn parallel=true agents=2 query=
agent_complete
```

- 命令:
```bash
sqlite3 "$HOME/.code-agent/code-agent.db" "SELECT id, status, total_agents, datetime(started_at/1000,'unixepoch','localtime') AS started_local FROM swarm_runs ORDER BY started_at DESC LIMIT 3;"
sqlite3 "$HOME/Library/Application Support/code-agent/code-agent.db" "SELECT id, status, total_agents, datetime(started_at/1000,'unixepoch','localtime') AS started_local FROM swarm_runs ORDER BY started_at DESC LIMIT 3;" 2>&1 || true
find "$HOME/.code-agent/swarm-runs" -maxdepth 1 -type f -name '*.jsonl' -print 2>/dev/null | sort
```
- 输出:
```text
2a8e14ea-7a3d-493b-9e24-c75c939321b6|completed|2|2026-05-28 17:05:47
Error: in prepare, no such table: swarm_runs
```

- 命令:
```bash
TOKEN=$(cat .dev-token)
curl -sS -X POST http://localhost:8180/api/domain/swarm/list-trace-runs -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"payload":{"limit":3}}' | jq -c '.'
RUN_ID=2a8e14ea-7a3d-493b-9e24-c75c939321b6
curl -sS -X POST http://localhost:8180/api/domain/swarm/get-trace-run-detail -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$(jq -nc --arg runId "$RUN_ID" '{payload:{runId:$runId}}')" | jq -c '{run:{id:.run.id,status:.run.status,totalAgents:.run.totalAgents,completedCount:.run.completedCount,failedCount:.run.failedCount,coordinator:.run.coordinator},agents:(.agents|map({name,role,status,tokensIn,tokensOut,toolCalls,filesChanged})),events_count:(.events|length),event_types:(.events|map(.eventType)|unique)}'
```
- 输出:
```json
[{"id":"2a8e14ea-7a3d-493b-9e24-c75c939321b6","sessionId":"e2e-sql-codex-20260528-mimo","status":"completed","coordinator":"hybrid","startedAt":1779959147695,"endedAt":1779959187691,"durationMs":39996,"totalAgents":2,"completedCount":2,"failedCount":0,"totalCostUsd":0,"totalTokensIn":0,"totalTokensOut":0,"trigger":"unknown"}]
{"run":{"id":"2a8e14ea-7a3d-493b-9e24-c75c939321b6","status":"completed","totalAgents":2,"completedCount":2,"failedCount":0,"coordinator":"hybrid"},"agents":[{"name":"explore","role":"explore","status":"completed","tokensIn":0,"tokensOut":0,"toolCalls":2,"filesChanged":[]},{"name":"coder","role":"coder","status":"completed","tokensIn":0,"tokensOut":0,"toolCalls":1,"filesChanged":[]}],"events_count":18,"event_types":["swarm:agent:added","swarm:agent:completed","swarm:agent:updated","swarm:completed","swarm:started"]}
```

Result: PASS for the actual default webServer SQL backend: SQL row exists, IPC returns detail, and `~/.code-agent/swarm-runs` remained empty. The task's Application Support DB path did not contain the table.

## B. file 模式落 jsonl

- 命令:
```bash
env CODE_AGENT_SWARM_STORAGE=file CODE_AGENT_E2E=1 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 npm run dev:web:server 2>&1 | tee /tmp/swarm-jsonl-file-server.log
```
- 输出:
```text
> code-agent@0.16.88 dev:web:server
> npm run build:web && node dist/web/webServer.cjs

> code-agent@0.16.88 build:web
> npm_config_cache=/tmp/code-agent-npm-cache npx tsx esbuild.config.ts web

Building 1 target(s)...
  ✓ Control plane public keys → dist/web/control-plane-public-keys.json (0 key(s))
  ✓ Web Server → dist/web/webServer.cjs (582ms)
Done.
[1/3] Initializing backend services...
2026-05-28T09:08:57.260Z INFO [WebServer] Database initialized
[2/3] Registering IPC handlers...
2026-05-28T09:08:57.275Z DEBUG [SwarmTraceWriter] SwarmTraceWriter installed
2026-05-28T09:08:57.275Z INFO [WebServer] SwarmServices registered for web mode
[3/3] Starting HTTP server...

{"port":8180,"token":"1ea4ba16-0508-4630-9627-efaf8defb408"}
```

- 命令:
```bash
TOKEN=$(cat .dev-token)
PROMPT="E2E acceptance for swarm trace. Follow these tool requirements exactly: (1) Your first tool call must be ToolSearch with query 'select:AgentSpawn' and maxResults 1. (2) After ToolSearch returns, your next tool call must be AgentSpawn, not TaskManager, not Bash, not Write, not Glob, not Read. (3) AgentSpawn arguments must set parallel=true and agents=[{role:'explore', task:'List all files under src/main/agent and summarize count only; do not edit files.'},{role:'coder', task:'Write the exact text hello to /tmp/swarm-e2e-test-file2.txt; do not touch the repository.'}]. Wait for both agents to finish, then reply with a short summary."
BODY=$(jq -nc --arg prompt "$PROMPT" '{prompt:$prompt,project:"/tmp/swarm-e2e",sessionId:"e2e-file-codex-20260528-mimo-2",provider:"xiaomi",model:"mimo-v2.5-pro"}')
timeout 900 curl -sS -N -X POST http://localhost:8180/api/run -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$BODY" -o /tmp/swarm-jsonl-b-file2-mimo.sse -w 'curl_http_code=%{http_code}\nbytes_downloaded=%{size_download}\ntime_total=%{time_total}\n'
```
- 输出:
```text
curl_http_code=200
bytes_downloaded=83727
time_total=101.613716
```

- 命令:
```bash
FILE=/tmp/swarm-jsonl-b-file2-mimo.sse node - <<'NODE'
const fs = require('fs');
const lines = fs.readFileSync(process.env.FILE, 'utf8').split(/\n/);
let event = null;
for (const line of lines) {
  if (line.startsWith('event: ')) {
    event = line.slice(7);
    continue;
  }
  if (!line.startsWith('data: ')) continue;
  let data;
  try { data = JSON.parse(line.slice(6)); } catch { continue; }
  if (event === 'tool_call_start' && (data.name === 'AgentSpawn' || data.name === 'ToolSearch')) {
    const args = data.arguments || {};
    console.log(`${event} name=${data.name} parallel=${args.parallel ?? ''} agents=${Array.isArray(args.agents) ? args.agents.length : ''} query=${args.query ?? ''}`);
  }
  if (event === 'tool_call_end' && typeof data.output === 'string' && data.output.includes('AgentSpawn')) {
    console.log(`${event} loaded_AgentSpawn success=${data.success}`);
  }
  if (event === 'agent_complete') console.log('agent_complete');
}
NODE
```
- 输出:
```text
tool_call_start name=ToolSearch parallel= agents= query=select:AgentSpawn
tool_call_end loaded_AgentSpawn success=true
tool_call_start name=AgentSpawn parallel=true agents=2 query=
agent_complete
```

- 命令:
```bash
find "$HOME/.code-agent/swarm-runs" -maxdepth 1 -type f -name '*.jsonl' -print0 2>/dev/null | xargs -0 ls -la
LATEST=$(find "$HOME/.code-agent/swarm-runs" -maxdepth 1 -type f -name '*.jsonl' -print 2>/dev/null | sort | tail -1)
basename "$LATEST" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}__.+\.jsonl$' || true
jq -c .type "$LATEST" | sort -u
head -8 "$LATEST"
```
- 输出:
```text
-rw-r--r--@ 1 linchen  staff  15648 May 28 17:14 /Users/linchen/.code-agent/swarm-runs/2026-05-28T171355__55b34f98-5830-46d4-a588-a9c4e15d2ef2.jsonl
2026-05-28T171355__55b34f98-5830-46d4-a588-a9c4e15d2ef2.jsonl
"agent_upserted"
"event"
"run_closed"
"run_started"
{"type":"run_started","runId":"55b34f98-5830-46d4-a588-a9c4e15d2ef2","sessionId":"e2e-file-codex-20260528-mimo-2","coordinator":"hybrid","startedAt":1779959635742,"totalAgents":2,"trigger":"unknown"}
{"type":"event","seq":0,"ts":1779959635742,"eventType":"swarm:started","agentId":null,"level":"info","title":"started","summary":"started total=2","payload":{"statistics":{"total":2,"completed":0,"failed":0,"running":0,"pending":2,"parallelPeak":0,"totalTokens":0,"totalToolCalls":0}}}
{"type":"agent_upserted","agentId":"agent_explore_0","name":"explore","role":"explore","status":"pending","startTime":null,"endTime":null,"durationMs":null,"tokensIn":0,"tokensOut":0,"toolCalls":0,"costUsd":0,"error":null,"failureCategory":null,"filesChanged":[]}
{"type":"event","seq":1,"ts":1779959635742,"eventType":"swarm:agent:added","agentId":"agent_explore_0","level":"info","title":"agent:added","summary":"agent_explore_0 → pending","payload":{"agentId":"agent_explore_0","agentState":{"id":"agent_explore_0","name":"explore","role":"explore","status":"pending","iterations":0}}}
{"type":"agent_upserted","agentId":"agent_coder_1","name":"coder","role":"coder","status":"pending","startTime":null,"endTime":null,"durationMs":null,"tokensIn":0,"tokensOut":0,"toolCalls":0,"costUsd":0,"error":null,"failureCategory":null,"filesChanged":[]}
{"type":"event","seq":2,"ts":1779959635742,"eventType":"swarm:agent:added","agentId":"agent_coder_1","level":"info","title":"agent:added","summary":"agent_coder_1 → pending","payload":{"agentId":"agent_coder_1","agentState":{"id":"agent_coder_1","name":"coder","role":"coder","status":"pending","iterations":0}}}
{"type":"agent_upserted","agentId":"agent_explore_0","name":"explore","role":"explore","status":"running","startTime":1779959635743,"endTime":null,"durationMs":null,"tokensIn":0,"tokensOut":0,"toolCalls":0,"costUsd":0,"error":null,"failureCategory":null,"filesChanged":[]}
{"type":"event","seq":3,"ts":1779959635743,"eventType":"swarm:agent:updated","agentId":"agent_explore_0","level":"info","title":"agent:updated","summary":"agent_explore_0 → running","payload":{"agentId":"agent_explore_0","agentState":{"id":"agent_explore_0","name":"","role":"","status":"running","startTime":1779959635743,"iterations":0}}}
```

- 命令:
```bash
TOKEN=$(cat .dev-token)
curl -sS -X POST http://localhost:8180/api/domain/swarm/list-trace-runs -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"payload":{"limit":3}}' | jq -c '.'
RUN_ID=55b34f98-5830-46d4-a588-a9c4e15d2ef2
curl -sS -X POST http://localhost:8180/api/domain/swarm/get-trace-run-detail -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$(jq -nc --arg runId "$RUN_ID" '{payload:{runId:$runId}}')" | jq -c '{run:{id:.run.id,status:.run.status,totalAgents:.run.totalAgents,completedCount:.run.completedCount,failedCount:.run.failedCount,coordinator:.run.coordinator,startedAt:.run.startedAt,endedAt:.run.endedAt},agents:(.agents|map({name,role,status,tokensIn,tokensOut,toolCalls,filesChanged})),events_count:(.events|length),event_types:(.events|map(.eventType)|unique)}'
sqlite3 "$HOME/.code-agent/code-agent.db" "SELECT id, status, total_agents FROM swarm_runs WHERE id = '$RUN_ID';"
```
- 输出:
```json
[{"id":"55b34f98-5830-46d4-a588-a9c4e15d2ef2","sessionId":"e2e-file-codex-20260528-mimo-2","status":"completed","coordinator":"hybrid","startedAt":1779959635742,"endedAt":1779959661210,"durationMs":25468,"totalAgents":2,"completedCount":2,"failedCount":0,"totalCostUsd":0,"totalTokensIn":0,"totalTokensOut":0,"trigger":"unknown"}]
{"run":{"id":"55b34f98-5830-46d4-a588-a9c4e15d2ef2","status":"completed","totalAgents":2,"completedCount":2,"failedCount":0,"coordinator":"hybrid","startedAt":1779959635742,"endedAt":1779959661210},"agents":[{"name":"explore","role":"explore","status":"completed","tokensIn":0,"tokensOut":0,"toolCalls":2,"filesChanged":[]},{"name":"coder","role":"coder","status":"completed","tokensIn":0,"tokensOut":0,"toolCalls":1,"filesChanged":[]}],"events_count":17,"event_types":["swarm:agent:added","swarm:agent:completed","swarm:agent:updated","swarm:completed","swarm:started"]}
```

Result: PASS. JSONL exists, filename matches timestamp prefix, four required entry types exist, IPC returns detail, and SQLite lookup for the file-mode run returns no row.

## C. 跨后端 parity

- 命令:
```bash
jq '{run:{coordinator:.run.coordinator,totalAgents:.run.totalAgents,completedCount:.run.completedCount,failedCount:.run.failedCount},agents:[.agents[]|{name,role,status,tokensIn,tokensOut,toolCalls,filesChanged}],events:[.events[]|{eventType,level,title,summary}]}' /tmp/swarm-jsonl-a-detail.json > /tmp/swarm-jsonl-a-normalized.json
jq '{run:{coordinator:.run.coordinator,totalAgents:.run.totalAgents,completedCount:.run.completedCount,failedCount:.run.failedCount},agents:[.agents[]|{name,role,status,tokensIn,tokensOut,toolCalls,filesChanged}],events:[.events[]|{eventType,level,title,summary}]}' /tmp/swarm-jsonl-b2-detail.json > /tmp/swarm-jsonl-b-normalized.json
jq -c '{run, agents, event_count:(.events|length), events}' /tmp/swarm-jsonl-a-normalized.json
jq -c '{run, agents, event_count:(.events|length), events}' /tmp/swarm-jsonl-b-normalized.json
diff -u /tmp/swarm-jsonl-a-normalized.json /tmp/swarm-jsonl-b-normalized.json || true
```
- 输出:
```json
{"run":{"coordinator":"hybrid","totalAgents":2,"completedCount":2,"failedCount":0},"agents":[{"name":"explore","role":"explore","status":"completed","tokensIn":0,"tokensOut":0,"toolCalls":2,"filesChanged":[]},{"name":"coder","role":"coder","status":"completed","tokensIn":0,"tokensOut":0,"toolCalls":1,"filesChanged":[]}],"event_count":18,"events":[{"eventType":"swarm:started","level":"info","title":"started","summary":"started total=2"},{"eventType":"swarm:agent:added","level":"info","title":"agent:added","summary":"agent_explore_0 → pending"},{"eventType":"swarm:agent:added","level":"info","title":"agent:added","summary":"agent_coder_1 → pending"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_coder_1 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_coder_1 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_coder_1 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_coder_1 → running"},{"eventType":"swarm:agent:completed","level":"info","title":"agent:completed","summary":"agent_coder_1 → completed"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:completed","level":"info","title":"agent:completed","summary":"agent_explore_0 → completed"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_coder_1 → completed"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → completed"},{"eventType":"swarm:completed","level":"info","title":"completed","summary":"completed=2 failed=0"}]}
{"run":{"coordinator":"hybrid","totalAgents":2,"completedCount":2,"failedCount":0},"agents":[{"name":"explore","role":"explore","status":"completed","tokensIn":0,"tokensOut":0,"toolCalls":2,"filesChanged":[]},{"name":"coder","role":"coder","status":"completed","tokensIn":0,"tokensOut":0,"toolCalls":1,"filesChanged":[]}],"event_count":17,"events":[{"eventType":"swarm:started","level":"info","title":"started","summary":"started total=2"},{"eventType":"swarm:agent:added","level":"info","title":"agent:added","summary":"agent_explore_0 → pending"},{"eventType":"swarm:agent:added","level":"info","title":"agent:added","summary":"agent_coder_1 → pending"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_coder_1 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_coder_1 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_coder_1 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_coder_1 → running"},{"eventType":"swarm:agent:completed","level":"info","title":"agent:completed","summary":"agent_coder_1 → completed"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → running"},{"eventType":"swarm:agent:completed","level":"info","title":"agent:completed","summary":"agent_explore_0 → completed"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_coder_1 → completed"},{"eventType":"swarm:agent:updated","level":"info","title":"agent:updated","summary":"agent_explore_0 → completed"},{"eventType":"swarm:completed","level":"info","title":"completed","summary":"completed=2 failed=0"}]}
```

```diff
--- /tmp/swarm-jsonl-a-normalized.json	2026-05-28 17:15:24
+++ /tmp/swarm-jsonl-b-normalized.json	2026-05-28 17:15:24
@@ -105,12 +105,6 @@
       "summary": "agent_explore_0 → running"
     },
     {
-      "eventType": "swarm:agent:updated",
-      "level": "info",
-      "title": "agent:updated",
-      "summary": "agent_explore_0 → running"
-    },
-    {
       "eventType": "swarm:agent:completed",
       "level": "info",
       "title": "agent:completed",
```

Result: PASS with note. `run` fields and `agents[]` match exactly. `events[]` field shape and ordering pattern match, but SQL has one extra duplicate `agent_explore_0 → running` progress event. I treat that as LLM/runtime progress variance, not JSONL contract drift.

## D. CLI 不 no-op

- 命令:
```bash
npm run build:cli
```
- 输出:
```text
> code-agent@0.16.88 build:cli
> npm_config_cache=/tmp/code-agent-npm-cache npx tsx esbuild.config.ts cli

Building 1 target(s)...
  ✓ CLI → dist/cli/index.cjs (595ms)
Done.
```

- 命令:
```bash
node dist/cli/index.cjs --help | sed -n '1,80p'
```
- 输出:
```text
Usage: code-agent [options] [command]

Agent Neo AI cowork 命令行工具

Options:
  -v, --version                 显示版本号
  -p, --project <path>          项目目录 (default:
                                "/Users/linchen/Downloads/ai/code-agent/.claude/worktrees/swarm-jsonl")
  --json                        JSON 格式输出
  --gen <id>                    使用的代际 (gen1-gen8)
  --model <name>                模型名称
  --provider <name>             模型提供商 (deepseek, openai, zhipu)
  --plan                        启用规划模式（复杂任务自动分解）
  --debug                       调试模式
  --output-format <format>      输出格式 (text|json|stream-json) (default: "text")
  --system-prompt <prompt>      自定义系统提示
  --metrics <path>              会话结束后写入指标 JSON（用于 eval 分析）
  -h, --help                    display help for command

Commands:
  chat [options]                进入交互式对话模式
  run [options] <prompt>        执行单次任务
  serve [options]               启动 HTTP API 服务
  export [options] [sessionId]  导出会话记录为 Markdown/JSON
  list-tools [options]          列出所有已注册的工具定义 (JSON)
  list-agents [options]         列出所有 Agent 角色定义（含 user / project 自定义，JSON 输出）
  exec-tool [options] <tool>    直接执行单个已注册工具，不经过模型回合
  init-soul [options]           生成 SOUL.md / PROFILE.md 模板（Agent 人格与项目上下文）
  openchronicle                 屏幕记忆（OpenChronicle daemon）开关
  debug                         调试快照、回放、决策树与压缩对比
  help [command]                display help for command
```

- 命令:
```bash
find "$HOME/.code-agent/swarm-runs" -maxdepth 1 -type f -name '*.jsonl' -print | sort
CODE_AGENT_SWARM_STORAGE=file HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 timeout 300 node dist/cli/index.cjs exec "E2E CLI swarm trace: use AgentSpawn with parallel=true two agents; explore lists src/main/agent; coder writes hello to /tmp/swarm-e2e-test-cli.txt" 2>&1
echo "exit_code=$?"
find "$HOME/.code-agent/swarm-runs" -maxdepth 1 -type f -name '*.jsonl' -print | sort
ls -l /tmp/swarm-e2e-test-cli.txt 2>&1 || true
```
- 输出:
```text
/Users/linchen/.code-agent/swarm-runs/2026-05-28T171355__55b34f98-5830-46d4-a588-a9c4e15d2ef2.jsonl
error: unknown command 'exec'
exit_code=1
/Users/linchen/.code-agent/swarm-runs/2026-05-28T171355__55b34f98-5830-46d4-a588-a9c4e15d2ef2.jsonl
ls: /tmp/swarm-e2e-test-cli.txt: No such file or directory
```

Result: FAIL. The exact requested CLI entry does not exist, so the CLI mode acceptance cannot be marked pass. I did not substitute `run` for `exec`.

## 发现的 Bug

- HIGH: CLI command mismatch blocks D.
  - Evidence: `node dist/cli/index.cjs --help` lists `run`, `chat`, `exec-tool`, etc., but no `exec`; exact `node dist/cli/index.cjs exec ...` returns `error: unknown command 'exec'` with exit code 1.
  - Root cause guess: product/acceptance docs still refer to an `exec` entry that is not registered in the Commander CLI. If the intended command is `run`, either add an `exec` alias or update the acceptance contract.
  - Fix suggestion: add a Commander alias/command `exec` that routes to the same single-run agent path as `run`, then ensure CLI bootstrap installs the file-backed `SwarmTraceWriter` when `CODE_AGENT_SWARM_STORAGE=file`.

- MED: Web E2E DB path in this worktree differs from task hint.
  - Evidence: `~/.code-agent/code-agent.db` contains the SQL run; `~/Library/Application Support/code-agent/code-agent.db` returns `no such table: swarm_runs`.
  - Root cause guess: platform path migration now resolves webServer userData to `~/.code-agent`, while the task hint used the older desktop Application Support path.
  - Fix suggestion: document the webServer DB path separately from packaged desktop DB path, or normalize `CODE_AGENT_DATA_DIR` in E2E docs.

## 备注 / 局限

- I did not run Phase 4/data migration checks. This audit is limited to Phase 1-3 backend switching.
- I did not stage or commit any generated `dist` output; `git status` was clean after builds before adding this report.
- File mode created one JSONL file under `~/.code-agent/swarm-runs`; I left it in place as acceptance evidence.

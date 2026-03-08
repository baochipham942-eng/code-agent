# ADR-006: Deferred Tools Consolidation (Phase 2)

## Status
Accepted

## Context
82+ deferred tools made model selection less accurate. Phase 1 renamed 11 core tools to PascalCase. Phase 2 consolidates functionally related deferred tools into unified tools with action parameters.

## Decision
Merge 31 deferred tools into 9 unified tools using action-based dispatch. Old names preserved as aliases in TOOL_ALIASES.

### Consolidated Tools

| Unified Tool | Merged From | Actions |
|--------------|-------------|---------|
| Process | process_list/poll/log/write/submit/kill + kill_shell + task_output (8→1) | list, poll, log, write, submit, kill, kill_shell, task_output |
| MCPUnified | mcp + mcp_list_tools/list_resources/read_resource/get_status/add_server (6→1) | call, list_tools, list_resources, read_resource, get_status, add_server |
| TaskManager | TaskCreate/Get/List/Update (4→1) | create, get, list, update |
| Plan | plan_read + plan_update (2→1) | read, update |
| PlanMode | enter_plan_mode + exit_plan_mode (2→1) | enter, exit |
| WebFetch | web_fetch + http_request (2→1) | fetch, http_request |
| ReadDocument | read_pdf + read_docx + read_xlsx (3→1) | pdf, docx, xlsx |
| Browser | browser_navigate + browser_action (2→1) | navigate, action |
| Computer | screenshot + computer_use (2→1) | screenshot, use |

### Not Merged

- **Group 5 (Memory)**: Already merged in a prior session.
- **Group 10 (Generate)**: 8 tools (ppt/pdf/image/video/docx/excel/chart/qrcode) have vastly different parameter schemas — merging would create an overly complex union type without improving model selection accuracy.

## Consequences
- Deferred tool entries reduced from 73 to 51
- Total registered tools: 90 → 99 (9 new unified tools registered alongside aliases)
- Model sees fewer tool options → better selection accuracy
- Old tool names still work via alias resolution (24 aliases)
- Each unified tool uses `action` as the dispatch parameter
- `executionPhase` and `agentLoop` metadata properly adapted for all unified tools
- 9 new implementation files (~41KB total): ProcessTool.ts, MCPUnifiedTool.ts, TaskManagerTool.ts, PlanTool.ts, PlanModeTool.ts, WebFetchUnifiedTool.ts, ReadDocumentTool.ts, BrowserTool.ts, ComputerTool.ts
- TypeScript compiles with zero errors

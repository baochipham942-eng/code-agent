#!/usr/bin/env python3
"""
创建/重建 Agent Neo 的 3 个 PostHog 看板及其 insights。幂等：按名字 lookup，存在则复用。
仅管理员可见——dashboard 在 PostHog org 的项目下，仅被邀进 org 的人可访问。

用法:
  POSTHOG_PERSONAL_API_KEY=phx_... python3 scripts/observability/posthog-dashboards.py

Personal API Key 需要 scopes: project:read + insight:read/write + dashboard:read/write。

实现说明：用 PostHog 新版 query 格式（InsightVizNode + TrendsQuery / FunnelsQuery）。
legacy filters 字段已被新账号拒收（"Creating or updating insights with legacy filters
is not available for this user"），统一走 query。
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

KEY = os.environ.get("POSTHOG_PERSONAL_API_KEY")
PROJECT_ID = os.environ.get("POSTHOG_PROJECT_ID", "353395")
BASE = f"https://us.posthog.com/api/projects/{PROJECT_ID}"

if not KEY:
    print("ERR: set POSTHOG_PERSONAL_API_KEY env", file=sys.stderr)
    sys.exit(1)

HEADERS = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def request(method: str, path: str, body: dict | None = None, retries: int = 2) -> dict:
    """SSL/网络抖动重试 2 次。HTTP 错误立刻报。"""
    import time as _time
    data = json.dumps(body).encode() if body is not None else None
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(f"{BASE}{path}", data=data, headers=HEADERS, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                txt = resp.read().decode()
                return json.loads(txt) if txt else {}
        except urllib.error.HTTPError as e:
            print(f"ERR {e.code} on {method} {path}: {e.read().decode()[:400]}", file=sys.stderr)
            raise
        except urllib.error.URLError as e:
            last_err = e
            if attempt < retries:
                _time.sleep(1 + attempt)
                continue
            raise
    raise RuntimeError(f"unreachable; last_err={last_err}")


def get_or_create_dashboard(name: str, description: str) -> dict:
    """按名字查；存在复用，不存在创建。"""
    q = urllib.parse.quote(name)
    resp = request("GET", f"/dashboards/?search={q}&limit=20")
    for d in resp.get("results", []):
        if d.get("name") == name and not d.get("deleted", False):
            print(f"  [reuse] dashboard #{d['id']}  {name}")
            return d
    d = request("POST", "/dashboards/", {"name": name, "description": description})
    print(f"  [new]   dashboard #{d['id']}  {name}")
    return d


def get_or_create_insight(name: str, dashboard_id: int, query: dict) -> dict:
    """在指定 dashboard 上查同名 insight；存在复用，不存在创建。"""
    resp = request("GET", f"/insights/?search={urllib.parse.quote(name)}&limit=20")
    for ins in resp.get("results", []):
        if ins.get("deleted", False):
            continue
        if ins.get("name") == name and dashboard_id in (ins.get("dashboards") or []):
            print(f"    [reuse] insight #{ins['id']}  {name}")
            return ins
    ins = request("POST", "/insights/", {"name": name, "query": query, "dashboards": [dashboard_id]})
    print(f"    [new]   insight #{ins['id']}  {name}")
    return ins


def trends(event: str, math: str = "total", breakdown: str | None = None) -> dict:
    series = [{"kind": "EventsNode", "event": event, "math": math}]
    source = {
        "kind": "TrendsQuery",
        "series": series,
        "interval": "day",
        "dateRange": {"date_from": "-30d"},
    }
    if breakdown:
        source["breakdownFilter"] = {"breakdown": breakdown, "breakdown_type": "event"}
    return {"kind": "InsightVizNode", "source": source}


def funnel(events: list[str]) -> dict:
    series = [{"kind": "EventsNode", "event": e} for e in events]
    return {
        "kind": "InsightVizNode",
        "source": {
            "kind": "FunnelsQuery",
            "series": series,
            "dateRange": {"date_from": "-30d"},
            "funnelsFilter": {
                "funnelWindowInterval": 1,
                "funnelWindowIntervalUnit": "hour",
            },
        },
    }


print(f"PostHog dashboards for project {PROJECT_ID}:")

d_engage = get_or_create_dashboard(
    "Agent Neo · User Engagement", "DAU / 累计活跃 / app_opened 趋势（管理员专用）"
)
d_runs = get_or_create_dashboard(
    "Agent Neo · Run Quality", "Run 完成/失败/取消 + 成功率漏斗（管理员专用）"
)
d_tools = get_or_create_dashboard(
    "Agent Neo · Tool Usage", "工具调用热度按 tool 属性 breakdown（管理员专用）"
)

print("\nInsights:")
get_or_create_insight("DAU (app_opened)", d_engage["id"], trends("app_opened", math="dau"))
get_or_create_insight("App opens (total, daily)", d_engage["id"], trends("app_opened"))
get_or_create_insight("Run completed (daily)", d_runs["id"], trends("run_completed"))
get_or_create_insight("Run failed (daily)", d_runs["id"], trends("run_failed"))
get_or_create_insight(
    "session → run_completed funnel", d_runs["id"], funnel(["session_started", "run_completed"])
)
get_or_create_insight(
    "Tool used by name (last 30d)", d_tools["id"], trends("tool_used", breakdown="tool")
)

print("\n看板 URLs(只你自己能看,admin-only via PostHog org membership):")
print(f"  https://us.posthog.com/project/{PROJECT_ID}/dashboard/{d_engage['id']}")
print(f"  https://us.posthog.com/project/{PROJECT_ID}/dashboard/{d_runs['id']}")
print(f"  https://us.posthog.com/project/{PROJECT_ID}/dashboard/{d_tools['id']}")

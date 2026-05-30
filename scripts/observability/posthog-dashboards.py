#!/usr/bin/env python3
"""
创建/重建 Agent Neo 的 3 个 PostHog 看板及其 insights。幂等：按名字 lookup，存在则复用。
仅管理员可见——dashboard 在 PostHog org 的项目下，仅被邀进 org 的人可访问。

用法:
  POSTHOG_PERSONAL_API_KEY=phx_... python3 scripts/observability/posthog-dashboards.py
  POSTHOG_PERSONAL_API_KEY=phx_... python3 scripts/observability/posthog-dashboards.py --verify-only
  python3 scripts/observability/posthog-dashboards.py --dry-run

Personal API Key 需要 scopes: project:read + insight:read/write + dashboard:read/write。

实现说明：用 PostHog 新版 query 格式（InsightVizNode + TrendsQuery / FunnelsQuery）。
legacy filters 字段已被新账号拒收（"Creating or updating insights with legacy filters
is not available for this user"），统一走 query。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description="Create Agent Neo PostHog dashboards.")
parser.add_argument("--dry-run", action="store_true", help="Print dashboard/insight specs without calling PostHog.")
parser.add_argument("--verify-only", action="store_true", help="Only verify existing dashboards/insights; do not create anything.")
args = parser.parse_args()

KEY = os.environ.get("POSTHOG_PERSONAL_API_KEY")
PROJECT_ID = os.environ.get("POSTHOG_PROJECT_ID", "353395")
POSTHOG_HOST = os.environ.get("POSTHOG_HOST", "https://us.posthog.com").rstrip("/")
BASE = f"{POSTHOG_HOST}/api/projects/{PROJECT_ID}"

if args.dry_run and args.verify_only:
    print("ERR: --dry-run and --verify-only cannot be combined", file=sys.stderr)
    sys.exit(1)

if not KEY and not args.dry_run:
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
        except (TimeoutError, urllib.error.URLError, OSError) as e:
            last_err = e
            if attempt < retries:
                _time.sleep(1 + attempt)
                continue
            raise
    raise RuntimeError(f"unreachable; last_err={last_err}")


def find_dashboard(name: str) -> dict | None:
    """按名字精确查 dashboard。"""
    q = urllib.parse.quote(name)
    resp = request("GET", f"/dashboards/?search={q}&limit=20")
    for d in resp.get("results", []):
        if d.get("name") == name and not d.get("deleted", False):
            return d
    return None


def get_or_create_dashboard(name: str, description: str) -> dict:
    """按名字查；存在复用，不存在创建。"""
    existing = find_dashboard(name)
    if existing:
        print(f"  [reuse] dashboard #{existing['id']}  {name}")
        return existing
    d = request("POST", "/dashboards/", {"name": name, "description": description})
    print(f"  [new]   dashboard #{d['id']}  {name}")
    return d


def coerce_int_id(value: object) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def dashboard_id(dashboard: dict) -> int:
    value = coerce_int_id(dashboard.get("id"))
    if value is None:
        raise RuntimeError(f"dashboard id is not numeric: {dashboard.get('id')!r}")
    return value


def insight_dashboard_ids(insight: dict) -> set[int]:
    dashboards = insight.get("dashboards") or []
    ids: set[int] = set()
    for dashboard in dashboards:
        if isinstance(dashboard, dict):
            value = dashboard.get("id")
        else:
            value = dashboard
        coerced = coerce_int_id(value)
        if coerced is not None:
            ids.add(coerced)
    return ids


def find_insight(name: str, dashboard_id: int) -> dict | None:
    """按名字和 dashboard 归属精确查 insight。"""
    resp = request("GET", f"/insights/?search={urllib.parse.quote(name)}&limit=20")
    for ins in resp.get("results", []):
        if ins.get("deleted", False):
            continue
        if ins.get("name") == name and dashboard_id in insight_dashboard_ids(ins):
            return ins
    return None


def get_or_create_insight(name: str, dashboard_id: int, query: dict) -> dict:
    """在指定 dashboard 上查同名 insight；存在复用，不存在创建。"""
    existing = find_insight(name, dashboard_id)
    if existing:
        print(f"    [reuse] insight #{existing['id']}  {name}")
        return existing
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


def dashboard_specs() -> list[dict]:
    return [
        {
            "name": "Agent Neo · User Engagement",
            "description": "DAU / 累计活跃 / app_opened 趋势（管理员专用）",
            "insights": [
                {"name": "DAU (app_opened)", "query": trends("app_opened", math="dau")},
                {"name": "App opens (total, daily)", "query": trends("app_opened")},
            ],
        },
        {
            "name": "Agent Neo · Run Quality",
            "description": "Run 完成/失败/取消 + 成功率漏斗（管理员专用）",
            "insights": [
                {"name": "Run completed (daily)", "query": trends("run_completed")},
                {"name": "Run failed (daily)", "query": trends("run_failed")},
                {
                    "name": "session → run_completed funnel",
                    "query": funnel(["session_started", "run_completed"]),
                },
            ],
        },
        {
            "name": "Agent Neo · Tool & Model Usage",
            "description": "工具调用热度和模型选择分布（管理员专用）",
            "insights": [
                {"name": "Tool used by name (last 30d)", "query": trends("tool_used", breakdown="tool")},
                {"name": "Model selected by model (last 30d)", "query": trends("model_selected", breakdown="model")},
                {"name": "Model selected by mode (last 30d)", "query": trends("model_selected", breakdown="mode")},
            ],
        },
    ]


if args.dry_run:
    specs = dashboard_specs()
    print(json.dumps({
        "project_id": PROJECT_ID,
        "posthog_host": POSTHOG_HOST,
        "expected": {
            "dashboards": len(specs),
            "insights": sum(len(spec["insights"]) for spec in specs),
        },
        "dashboards": specs,
    }, ensure_ascii=False, indent=2))
    sys.exit(0)


def verify_dashboards() -> tuple[list[dict], int]:
    """反查 PostHog 当前项目，确认预期 dashboard 和 insight 都已经存在。"""
    dashboards: list[dict] = []
    insight_count = 0
    missing: list[str] = []

    print("\nVerify:")
    for spec in dashboard_specs():
        dashboard = find_dashboard(spec["name"])
        if not dashboard:
            missing.append(f"dashboard: {spec['name']}")
            print(f"  [missing] dashboard      {spec['name']}")
            continue
        dashboard_numeric_id = dashboard_id(dashboard)
        dashboards.append(dashboard)
        print(f"  [ok]      dashboard #{dashboard_numeric_id}  {spec['name']}")

        for insight in spec["insights"]:
            found = find_insight(insight["name"], dashboard_numeric_id)
            if not found:
                missing.append(f"insight: {spec['name']} / {insight['name']}")
                print(f"    [missing] insight        {insight['name']}")
                continue
            insight_count += 1
            print(f"    [ok]      insight #{found['id']}  {insight['name']}")

    expected_dashboards = len(dashboard_specs())
    expected_insights = sum(len(spec["insights"]) for spec in dashboard_specs())
    if missing:
        print("\nERR: PostHog dashboard verification failed:", file=sys.stderr)
        for item in missing:
            print(f"  - {item}", file=sys.stderr)
        sys.exit(1)

    print(f"\nVerified: {len(dashboards)}/{expected_dashboards} dashboards, {insight_count}/{expected_insights} insights")
    return dashboards, insight_count


if args.verify_only:
    print(f"Verify Agent Neo PostHog dashboards for project {PROJECT_ID}:")
    verify_dashboards()
    sys.exit(0)


print(f"PostHog dashboards for project {PROJECT_ID}:")

print("\nInsights:")
for spec in dashboard_specs():
    dashboard = get_or_create_dashboard(spec["name"], spec["description"])
    for insight in spec["insights"]:
        get_or_create_insight(insight["name"], dashboard_id(dashboard), insight["query"])

verified_dashboards, _ = verify_dashboards()

print("\n看板 URLs(只你自己能看,admin-only via PostHog org membership):")
for dashboard in verified_dashboards:
    print(f"  {POSTHOG_HOST}/project/{PROJECT_ID}/dashboard/{dashboard_id(dashboard)}")

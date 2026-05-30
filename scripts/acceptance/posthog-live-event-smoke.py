#!/usr/bin/env python3
"""
PostHog live event smoke.

Required:
  POSTHOG_KEY               Project API Key (phc_...), used for event capture.

Optional:
  POSTHOG_HOST              Ingest host, default https://us.i.posthog.com.
  POSTHOG_PERSONAL_API_KEY  Personal API Key, used for readback.
  POSTHOG_PROJECT_ID        Project id, default 353395.
  POSTHOG_API_HOST          API host, default https://us.posthog.com.

By default the script sends one smoke event and, when a Personal API Key is
provided, tries to read it back through HogQL. If the key lacks query:read, it
falls back to a temporary insight refresh, which requires insight read/write.
Use --capture-only to verify only the ingest path.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request


parser = argparse.ArgumentParser(description="Send and optionally read back a PostHog smoke event.")
parser.add_argument("--capture-only", action="store_true", help="Only require PostHog capture to accept the event.")
parser.add_argument(
    "--readback-mode",
    choices=["auto", "query", "insight"],
    default="auto",
    help="How to read the smoke event back when POSTHOG_PERSONAL_API_KEY is set.",
)
args = parser.parse_args()

project_key = os.environ.get("POSTHOG_KEY")
if not project_key:
    print("ERR: set POSTHOG_KEY env", file=sys.stderr)
    sys.exit(1)

personal_key = os.environ.get("POSTHOG_PERSONAL_API_KEY")
project_id = os.environ.get("POSTHOG_PROJECT_ID", "353395")
ingest_host = os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com").rstrip("/")
api_host = os.environ.get("POSTHOG_API_HOST", "https://us.posthog.com").rstrip("/")

smoke_id = f"codex_{int(time.time())}"
event = "agent_neo_posthog_live_smoke"
distinct_id = f"agent_neo_smoke_{smoke_id}"


class MissingScopeError(Exception):
    pass


def request_json(method: str, url: str, body: dict | None, headers: dict[str, str], retries: int = 2) -> dict:
    import time as _time
    data = json.dumps(body).encode() if body is not None else None
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json", **headers},
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                text = resp.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError:
            raise
        except (TimeoutError, urllib.error.URLError, OSError) as err:
            last_error = err
            if attempt < retries:
                _time.sleep(1 + attempt)
                continue
            raise
    raise RuntimeError(f"unreachable; last_error={last_error}")


capture_body = {
    "api_key": project_key,
    "event": event,
    "distinct_id": distinct_id,
    "properties": {
        "source": "codex_acceptance",
        "scope": "posthog_live_event_smoke",
        "smoke_id": smoke_id,
    },
}

capture_result = request_json("POST", f"{ingest_host}/capture/", capture_body, {})
if capture_result.get("status") != "Ok":
    print(f"ERR: capture returned unexpected payload: {capture_result}", file=sys.stderr)
    sys.exit(1)

print(f"capture_ok=true event={event} smoke_id={smoke_id}")

if args.capture_only or not personal_key:
    if not personal_key:
        print("query_skipped=true reason=missing_POSTHOG_PERSONAL_API_KEY")
    elif args.capture_only:
        print("query_skipped=true reason=capture_only")
    sys.exit(0)

headers = {"Authorization": f"Bearer {personal_key}"}


def readback_with_query() -> bool:
    query = {
        "query": {
            "kind": "HogQLQuery",
            "query": (
                "select event, distinct_id, properties.smoke_id "
                "from events "
                f"where event = '{event}' and properties.smoke_id = '{smoke_id}' "
                "order by timestamp desc limit 1"
            ),
        }
    }

    last_result = ""
    for attempt in range(12):
        time.sleep(2 if attempt else 1)
        try:
            payload = request_json("POST", f"{api_host}/api/projects/{project_id}/query/", query, headers)
        except urllib.error.HTTPError as err:
            detail = err.read().decode()[:400]
            if err.code == 403 and "query:read" in detail:
                raise MissingScopeError("query:read")
            print(f"ERR: query readback failed HTTP {err.code}: {detail}", file=sys.stderr)
            sys.exit(1)

        results = payload.get("results") or []
        last_result = json.dumps(results[:1], ensure_ascii=False)
        if results:
            print(f"query_found=true mode=query event={event} smoke_id={smoke_id}")
            return True

    print(f"query_found=false mode=query last={last_result}")
    return False


def readback_with_insight() -> bool:
    insight_query = {
        "kind": "InsightVizNode",
        "source": {
            "kind": "TrendsQuery",
            "series": [
                {
                    "kind": "EventsNode",
                    "event": event,
                    "math": "total",
                    "properties": [
                        {
                            "key": "smoke_id",
                            "value": smoke_id,
                            "operator": "exact",
                            "type": "event",
                        }
                    ],
                }
            ],
            "interval": "day",
            "dateRange": {"date_from": "-24h"},
        },
    }
    insight: dict | None = None
    try:
        insight = request_json(
            "POST",
            f"{api_host}/api/projects/{project_id}/insights/",
            {"name": f"Agent Neo smoke readback {smoke_id}", "query": insight_query},
            headers,
        )
        insight_id = insight.get("id")
        if not insight_id:
            print(f"ERR: insight readback did not return id: {insight}", file=sys.stderr)
            sys.exit(1)

        last_result = ""
        for attempt in range(12):
            time.sleep(2 if attempt else 1)
            refreshed = request_json(
                "GET",
                f"{api_host}/api/projects/{project_id}/insights/{insight_id}/?refresh=true",
                None,
                headers,
            )
            result = refreshed.get("result") or []
            last_result = json.dumps(result[:1], ensure_ascii=False)
            count = 0
            if result and isinstance(result[0], dict):
                raw_count = result[0].get("count")
                count = raw_count if isinstance(raw_count, (int, float)) else 0
            if count >= 1:
                print(f"query_found=true mode=insight event={event} smoke_id={smoke_id} count={count}")
                return True

        print(f"query_found=false mode=insight last={last_result}")
        return False
    except urllib.error.HTTPError as err:
        detail = err.read().decode()[:400]
        print(f"ERR: insight readback failed HTTP {err.code}: {detail}", file=sys.stderr)
        sys.exit(1)
    finally:
        insight_id = insight.get("id") if isinstance(insight, dict) else None
        if insight_id:
            try:
                request_json(
                    "PATCH",
                    f"{api_host}/api/projects/{project_id}/insights/{insight_id}/",
                    {"deleted": True},
                    headers,
                )
                print(f"temporary_insight_deleted=true id={insight_id}")
            except Exception as err:
                print(f"temporary_insight_deleted=false id={insight_id} reason={type(err).__name__}", file=sys.stderr)


if args.readback_mode == "query":
    if readback_with_query():
        sys.exit(0)
elif args.readback_mode == "insight":
    if readback_with_insight():
        sys.exit(0)
else:
    try:
        if readback_with_query():
            sys.exit(0)
    except MissingScopeError:
        print("query_readback_skipped=true reason=missing_query_read_scope")
        if readback_with_insight():
            sys.exit(0)

print(f"ERR: smoke event not found after polling event={event} smoke_id={smoke_id}", file=sys.stderr)
sys.exit(1)

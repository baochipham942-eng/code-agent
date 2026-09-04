"""Inspect tasks for same-model Neo/Codex/Kimi/Grok harness comparison."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from inspect_ai import Task, task
from inspect_ai.agent import Agent, AgentState, agent, sandbox_agent_bridge
from inspect_ai.dataset import json_dataset
from inspect_ai.model import (
    ChatMessageAssistant,
    ChatMessageTool,
    ChatMessageUser,
    GenerateInput,
    ModelCost,
    ModelInfo,
    set_model_cost,
    set_model_info,
)
from inspect_ai.scorer import Score, Scorer, Target, accuracy, mean, scorer
from inspect_ai.solver import Generate, Solver, TaskState, solver
from inspect_ai.util import sandbox, store
from inspect_swe import codex_cli, kimi_code, opencode

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = str(REPO_ROOT / ".code-agent" / "inspect" / "five-case.jsonl")
COMPOSE_FILE = str(Path(__file__).with_name("compose.yaml"))
CONTAINER_REPO_ROOT = "/app"
NEO_CLI = f"{CONTAINER_REPO_ROOT}/dist/cli/index.cjs"
SCORER_CLI = f"{CONTAINER_REPO_ROOT}/scripts/inspect/score-case.ts"
RUN_ROOT = "/tmp/inspect-harnessdiff"
SAMPLE_TOKEN_LIMIT = 150_000
SAMPLE_COST_LIMIT_USD = 0.03

# Tokenrhythm exposes this model through an OpenAI-compatible custom endpoint,
# so Inspect's built-in catalog has no entry to attach the external cost table to.
set_model_info(
    "openai/deepseek-v4-flash",
    ModelInfo(
        context_length=1_000_000,
        output_tokens=32_768,
        organization="Tokenrhythm",
        model="deepseek-v4-flash",
        reasoning=True,
    ),
)


def _message_text(message: Any) -> str:
    text = getattr(message, "text", None)
    if isinstance(text, str):
        return text
    content = getattr(message, "content", "")
    return content if isinstance(content, str) else str(content)


def extract_assertion_context(messages: list[Any]) -> dict[str, Any]:
    calls: dict[str, dict[str, Any]] = {}
    tool_executions: list[dict[str, Any]] = []
    responses: list[str] = []
    errors: list[str] = []
    trace: list[dict[str, Any]] = []
    turn_count = 0

    for message in messages:
        if isinstance(message, ChatMessageAssistant):
            turn_count += 1
            message_calls: list[dict[str, Any]] = []
            for call in message.tool_calls or []:
                call_record = {"id": call.id, "tool": call.function, "input": call.arguments}
                calls[call.id] = call_record
                message_calls.append(call_record)
            text = _message_text(message).strip()
            trace.append({
                "step": len(trace) + 1,
                "kind": "assistant",
                "turn": turn_count,
                "text": text,
                "tool_calls": message_calls,
            })
            if text and not message.tool_calls:
                responses.append(text)
        elif isinstance(message, ChatMessageTool):
            call = calls.get(message.tool_call_id or "", {
                "tool": message.function or "unknown",
                "input": {},
            })
            error = str(message.error) if message.error else None
            output = _message_text(message)
            execution = {
                "tool": call["tool"],
                "input": call["input"],
                "output": output,
                "success": error is None,
                **({"error": error} if error else {}),
                "duration": 0,
                "timestamp": 0,
            }
            tool_executions.append(execution)
            trace.append({"step": len(trace) + 1, "kind": "tool", **execution})
            if error:
                errors.append(error)

    return {
        "toolExecutions": tool_executions,
        "responses": responses,
        "errors": errors,
        "turnCount": turn_count,
        "trace": trace,
    }


async def _prepare_workspace(harness: str) -> tuple[str, str]:
    test_case = store().get("harness_case", {})
    sample = str(test_case.get("id", "sample"))
    run_id = str(uuid.uuid4())
    isolated_home = f"{RUN_ROOT}/homes/{harness}/{run_id}"
    workspace = f"{RUN_ROOT}/workspaces/{harness}/{sample}-{run_id}"
    await sandbox().exec(["mkdir", "-p", isolated_home, workspace])
    copy_result = await sandbox().exec(
        ["cp", f"{CONTAINER_REPO_ROOT}/package.json", f"{workspace}/package.json"]
    )
    if not copy_result.success:
        raise RuntimeError(f"workspace seed failed: {copy_result.stderr}")
    for command in test_case.get("setup", []) or []:
        result = await sandbox().exec(["bash", "-c", command], cwd=workspace, timeout=60)
        if not result.success:
            raise RuntimeError(f"case setup failed: {result.stderr}")
    store().set("harness_runtime", {
        "harness": harness,
        "harness_workspace": workspace,
    })
    return workspace, isolated_home


def _lifecycle_agent(harness: str, build_agent: Callable[[str, str], Agent]) -> Agent:
    @agent(name=f"{harness}_harness")
    def lifecycle() -> Agent:
        async def execute(state: AgentState) -> AgentState:
            workspace, isolated_home = await _prepare_workspace(harness)
            runtime = store().get("harness_runtime", {})
            runtime["config_isolation"] = (
                {
                    "process_home": "/root",
                    "config_root": "/root/.kimi-code",
                    "scope": "per-sample container",
                    "workspace": str(workspace),
                }
                if harness == "kimi"
                else {
                    "process_home": str(isolated_home),
                    "workspace": str(workspace),
                }
            )
            store().set("harness_runtime", runtime)
            cli_agent = build_agent(workspace, isolated_home)
            follow_ups = store().get("harness_case", {}).get("follow_up_prompts", []) or []
            current = await cli_agent(state)
            for prompt in follow_ups:
                current.messages.append(ChatMessageUser(content=prompt))
                current = await cli_agent(current)
            runtime["follow_up_prompts_sent"] = follow_ups
            store().set("harness_runtime", runtime)
            return current

        return execute

    return lifecycle()


def _assistant_count(messages: list[Any]) -> int:
    return sum(1 for message in messages if isinstance(message, ChatMessageAssistant))


def _last_assistant(messages: list[Any]) -> ChatMessageAssistant | None:
    for message in reversed(messages):
        if isinstance(message, ChatMessageAssistant):
            return message
    return None


def _follow_up_request_has_history(messages: list[Any]) -> bool:
    """True when the CLI follow-up request carried first-turn context.

    Neo restore merges the first-turn tool-call assistant and answer into one
    message, so assistant count alone is not enough; a tool result is.
    """
    if any(isinstance(message, ChatMessageTool) for message in messages):
        return True
    return _assistant_count(messages) >= 2


def _message_fingerprint(message: Any) -> tuple[str, str]:
    """(role, text) identity. Same cut as inspect_ai (role, mm3(text))."""
    role = getattr(message, "role", "") or ""
    return (str(role), _message_text(message).strip())


def _invocation_tail(adopted: list[Any], forwarded: list[Any]) -> list[Any]:
    """New messages from this invocation: adopted after the shared prefix.

    Bridge may return `forwarded + tail`, or a full replace whose first-turn
    shape differs (Neo merges tool-call+answer into one assistant). Cut by
    fingerprint prefix, not `len(forwarded)`. When the prefix does not cover
    forwarded, take messages after the last user (the follow-up prompt).
    Mirrored by `invocationTail` in traceHealth.ts — change both.
    """
    forwarded_fps = [_message_fingerprint(message) for message in forwarded]
    adopted_fps = [_message_fingerprint(message) for message in adopted]
    lcp = 0
    for left, right in zip(forwarded_fps, adopted_fps):
        if left != right:
            break
        lcp += 1
    if lcp == len(forwarded):
        return list(adopted[lcp:])
    last_user = -1
    for index, fingerprint in enumerate(adopted_fps):
        if fingerprint[0] == "user":
            last_user = index
    if last_user >= 0:
        return list(adopted[last_user + 1 :])
    return list(adopted[lcp:])


def _assert_invocation_grew(*, before: int, after: int, invocation: int) -> None:
    if after <= before:
        raise RuntimeError(
            "inspect trace health failed at invocation "
            f"{invocation}: assistant count {before} -> {after} (expected strict growth)"
        )


def _assert_follow_up_complete(*, final: int, baseline: int, follow_ups: list[str]) -> None:
    required = baseline + len(follow_ups)
    if final < required:
        raise RuntimeError(
            "inspect trace health failed after follow-ups: "
            f"assistant count {final} < {required} "
            f"(baseline {baseline} + {len(follow_ups)} follow-ups)"
        )


# `run --output-format text` prints this after a successful turn. ANSI-safe:
# stop at whitespace or an escape so chalk wrapping cannot leak into the id.
_CLI_SESSION_ID_RE = re.compile(r"会话 ID:\s*([^\s\x1b]+)")


def parse_cli_session_id(*chunks: str) -> str | None:
    """Extract the session id Neo CLI prints after `run` (text mode)."""
    text = "\n".join(chunk for chunk in chunks if chunk)
    match = _CLI_SESSION_ID_RE.search(text)
    return match.group(1) if match else None


async def read_persisted_neo_session_id(neo_home: str) -> str:
    """Read the session the first Neo process actually created.

    `--session <id>` is restore-only. If the id is missing, `run` creates a
    new `cli_session_*` row and ignores the requested id. Follow-up processes
    must resume that persisted id, not the inspect-side uuid.
    """
    db_path = f"{neo_home}/code-agent.db"
    script = (
        "const Database = require('better-sqlite3');"
        f"const db = new Database({json.dumps(db_path)}, {{ readonly: true, fileMustExist: true }});"
        "const row = db.prepare("
        "'SELECT id FROM sessions WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 1'"
        ").get('cli_session_%');"
        "if (!row || typeof row.id !== 'string' || !row.id) {"
        "  throw new Error('no persisted neo session');"
        "}"
        "const count = db.prepare("
        "'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?'"
        ").get(row.id);"
        "if (!count || Number(count.n) < 1) {"
        "  throw new Error('persisted neo session has no messages');"
        "}"
        "const branch = db.prepare("
        "'SELECT 1 AS ok FROM conversation_branches WHERE session_id = ? LIMIT 1'"
        ").get(row.id);"
        "if (!branch) {"
        "  throw new Error('persisted neo session has no conversation ledger');"
        "}"
        "process.stdout.write(row.id);"
    )
    result = await sandbox().exec(
        cmd=["node", "-e", script],
        cwd=CONTAINER_REPO_ROOT,
        timeout=30,
    )
    if not result.success:
        raise RuntimeError(
            "failed to read persisted neo session: "
            f"{result.stderr}\n{result.stdout}"
        )
    session_id = result.stdout.strip()
    if not session_id:
        raise RuntimeError("persisted neo session id was empty")
    return session_id


def scorer_trace_health(
    follow_up_prompts_sent: list[str],
    turn_count: int,
    first_invocation_assistant_count: Any = None,
) -> str:
    """Soft label for scorer metadata. Missing first-invocation count stays ok.

    Codex/Kimi lifecycle and historical logs do not set the field; do not
    mislabel them. Neo/Grok store the count after the first CLI process.
    """
    if not follow_up_prompts_sent:
        return "ok"
    if not isinstance(first_invocation_assistant_count, int):
        return "ok"
    required = first_invocation_assistant_count + len(follow_up_prompts_sent)
    return "broken" if turn_count < required else "ok"


async def _forward_bridged_invocations(
    state: AgentState,
    prompts: list[str],
    invoke: Callable[[Any, str, int], Awaitable[None]],
) -> tuple[AgentState, list[str], int]:
    """One fresh sandbox_agent_bridge per CLI process, forwarding state.

    inspect_ai adopts the first generation of a fresh bridge unconditionally.
    A shared bridge parks Neo follow-ups when SQLite re-render breaks the
    byte-level prefix used by `_track_state`.
    """
    current = state
    baseline = _assistant_count(current.messages)
    first_after = baseline
    for index, prompt in enumerate(prompts):
        if index > 0:
            current.messages.append(ChatMessageUser(content=prompt))
        forwarded = list(current.messages)
        before = _assistant_count(forwarded)
        previous = _last_assistant(forwarded)
        previous_text = _message_text(previous).strip() if previous else ""
        async with sandbox_agent_bridge(current, sandbox="default") as bridge:
            await invoke(bridge, prompt, index)
            adopted = bridge.state
        if index == 0:
            current = adopted
        else:
            last = _last_assistant(adopted.messages)
            last_text = _message_text(last).strip() if last else ""
            if last is None or last_text == previous_text:
                current = adopted
            elif _follow_up_request_has_history(adopted.messages):
                # Fresh-bridge `_adopt_thread` replaces state in place.
                # Neo resume may merge first-turn tool-call+answer into one
                # assistant. Keep the forwarded first-turn trace and append
                # this invocation's full new tail (tool-call assistant + tool
                # + answer), not only the last assistant.
                adopted.messages = forwarded + _invocation_tail(
                    adopted.messages, forwarded
                )
                current = adopted
            else:
                current = adopted
        after = _assistant_count(current.messages)
        _assert_invocation_grew(before=before, after=after, invocation=index)
        if index == 0:
            first_after = after
    follow_ups = prompts[1:]
    _assert_follow_up_complete(
        final=_assistant_count(current.messages),
        baseline=baseline,
        follow_ups=follow_ups,
    )
    return current, follow_ups, first_after


def _codex_agent(workspace: str, isolated_home: str) -> Agent:
    codex_home = f"{isolated_home}/codex"
    return codex_cli(
        cwd=workspace,
        home_dir=codex_home,
        version="sandbox",
        model_config="gpt-5.3-codex",
        web_search="disabled",
        goals=False,
        sandbox=None,
        env={"HOME": isolated_home},
        filter=_drop_unsupported_codex_cache_key,
    )


async def _drop_unsupported_codex_cache_key(
    _model: Any,
    messages: list[Any],
    tools: list[Any],
    tool_choice: Any,
    config: Any,
) -> GenerateInput | None:
    extra_body = config.extra_body
    if not isinstance(extra_body, dict) or "prompt_cache_key" not in extra_body:
        return None
    supported_extra_body = dict(extra_body)
    supported_extra_body.pop("prompt_cache_key")
    return GenerateInput(
        input=messages,
        tools=tools,
        tool_choice=tool_choice,
        config=config.model_copy(update={"extra_body": supported_extra_body or None}),
    )


def _kimi_agent(workspace: str, _isolated_home: str) -> Agent:
    return kimi_code(
        cwd=workspace,
        version="sandbox",
        sandbox=None,
    )


def _opencode_agent(workspace: str, isolated_home: str) -> Agent:
    return opencode(
        cwd=workspace,
        version="sandbox",
        sandbox=None,
        opencode_model="openai/inspect",
        env={"HOME": isolated_home},
    )


@agent
def neo_cli_agent() -> Agent:
    async def execute(state: AgentState) -> AgentState:
        workspace, isolated_home = await _prepare_workspace("neo")
        neo_home = f"{isolated_home}/neo-data"
        await sandbox().exec(["mkdir", "-p", neo_home])
        runtime = store().get("harness_runtime", {})
        runtime["config_isolation"] = {
            "process_home": isolated_home,
            "data_dir": neo_home,
            "workspace": workspace,
        }
        store().set("harness_runtime", runtime)
        prompts = [
            state.messages[-1].text,
            *(store().get("harness_case", {}).get("follow_up_prompts", []) or []),
        ]
        # Neo `--session` restores an existing row; it does not pin a new
        # session to this id. First process creates `cli_session_*`; later
        # processes resume that persisted id (Grok's --session-id / --resume).
        session_id: str | None = None

        async def invoke(bridge: Any, prompt: str, index: int) -> None:
            nonlocal session_id
            cmd = [
                "node", NEO_CLI, "--project", workspace,
                "--provider", "openai", "--model", "inspect",
                "--output-format", "text", "run", prompt,
                "--dangerously-skip-permissions",
            ]
            if index > 0:
                if not session_id:
                    raise RuntimeError(
                        "neo follow-up has no persisted session id to resume"
                    )
                cmd.extend(["--session", session_id])
            result = await sandbox().exec(
                cmd=cmd,
                cwd=workspace,
                env={
                    "HOME": isolated_home,
                    "CODE_AGENT_DATA_DIR": neo_home,
                    "CODE_AGENT_CLI_MODE": "1",
                    "EVAL_DISABLED": "true",
                    "OPENAI_BASE_URL": f"http://localhost:{bridge.port}/v1",
                    "OPENAI_API_KEY": "inspect-bridge-placeholder",
                },
                timeout=300,
            )
            if not result.success:
                raise RuntimeError(f"Neo CLI failed: {result.stderr}\n{result.stdout}")
            if index == 0:
                session_id = parse_cli_session_id(result.stdout, result.stderr)
                if not session_id:
                    session_id = await read_persisted_neo_session_id(neo_home)

        current, follow_ups, first_after = await _forward_bridged_invocations(
            state, prompts, invoke
        )
        runtime["follow_up_prompts_sent"] = follow_ups
        runtime["first_invocation_assistant_count"] = first_after
        store().set("harness_runtime", runtime)
        return current

    return execute


@agent
def grok_cli_agent() -> Agent:
    async def execute(state: AgentState) -> AgentState:
        workspace, isolated_home = await _prepare_workspace("grok")
        grok_home = f"{isolated_home}/.grok"
        await sandbox().exec(["mkdir", "-p", grok_home])
        runtime = store().get("harness_runtime", {})
        runtime["config_isolation"] = {
            "process_home": isolated_home,
            "grok_home": grok_home,
            "workspace": workspace,
        }
        store().set("harness_runtime", runtime)
        prompts = [
            state.messages[-1].text,
            *(store().get("harness_case", {}).get("follow_up_prompts", []) or []),
        ]
        session_id = str(uuid.uuid4())

        async def invoke(bridge: Any, prompt: str, index: int) -> None:
            config = "\n".join([
                "[models]", 'default = "inspect"', "", "[model.inspect]",
                'model = "inspect"',
                f'base_url = "http://localhost:{bridge.port}/v1"',
                'api_key = "inspect-bridge-placeholder"',
                'api_backend = "chat_completions"',
                "context_window = 1000000", "max_completion_tokens = 32768", "",
            ])
            await sandbox().write_file(f"{grok_home}/config.toml", config)
            cmd = [
                "grok", "--cwd", workspace, "--model", "inspect",
                "--output-format", "plain", "--permission-mode", "bypassPermissions",
                "--sandbox", "off", "--no-plan", "--no-subagents",
                "--disable-web-search", "--verbatim",
            ]
            cmd.extend(["--session-id", session_id] if index == 0 else ["--resume", session_id])
            cmd.extend(["--single", prompt])
            result = await sandbox().exec(
                cmd=cmd,
                cwd=workspace,
                env={
                    "HOME": isolated_home,
                    "GROK_HOME": grok_home,
                    "XAI_API_KEY": "inspect-bridge-placeholder",
                },
                timeout=300,
            )
            if not result.success:
                raise RuntimeError(f"Grok CLI failed: {result.stderr}\n{result.stdout}")

        current, follow_ups, first_after = await _forward_bridged_invocations(
            state, prompts, invoke
        )
        runtime["follow_up_prompts_sent"] = follow_ups
        runtime["first_invocation_assistant_count"] = first_after
        store().set("harness_runtime", runtime)
        return current

    return execute


@scorer(metrics=[accuracy(), mean()])
def neo_assertion_scorer() -> Scorer:
    async def score(state: TaskState, target: Target) -> Score:
        test_case = state.metadata.get("case")
        workspace = state.metadata.get("harness_workspace")
        if not isinstance(test_case, dict) or not isinstance(workspace, str):
            raise RuntimeError("Inspect sample case or workspace metadata is missing")

        context = extract_assertion_context(state.messages)
        request_path = f"/tmp/inspect-score-{state.sample_id}-{uuid.uuid4()}.json"
        await sandbox().write_file(
            request_path,
            json.dumps({"case": test_case, "context": context}, ensure_ascii=False),
        )
        result = await sandbox().exec(
            cmd=[f"{CONTAINER_REPO_ROOT}/node_modules/.bin/tsx", SCORER_CLI, request_path, workspace],
            cwd=CONTAINER_REPO_ROOT,
            timeout=60,
        )
        if not result.success:
            raise RuntimeError(f"Neo assertion scorer failed: {result.stderr}")
        scored = json.loads(result.stdout)
        follow_up_prompts_sent = list(state.metadata.get("follow_up_prompts_sent") or [])
        return Score(
            value=float(scored["score"]),
            answer="\n".join(context["responses"]),
            explanation=scored.get("failureReason") or scored["status"],
            metadata={
                "harness": state.metadata.get("harness"),
                "test_id": scored["testId"],
                "tool_evidence": context["toolExecutions"],
                "trace": context["trace"],
                "turn_count": context["turnCount"],
                "config_isolation": state.metadata.get("config_isolation"),
                "follow_up_prompts_sent": follow_up_prompts_sent,
                "trace_health": scorer_trace_health(
                    follow_up_prompts_sent,
                    context["turnCount"],
                    state.metadata.get("first_invocation_assistant_count"),
                ),
                "assertion_result": scored,
            },
        )

    return score


@solver
def harness_agent_solver(cli_agent: Agent) -> Solver:
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        store().set("harness_case", state.metadata.get("case", {}))
        store().set("harness_runtime", {})
        agent_state = AgentState(messages=state.messages)
        result = await cli_agent(agent_state)
        state.messages = result.messages
        state.output = result.output
        state.metadata.update(store().get("harness_runtime", {}))
        return state

    return solve


def _task_for(cli_agent: Agent, dataset: str) -> Task:
    set_model_info(
        "openai/deepseek-v4-flash",
        ModelInfo(
            context_length=1_000_000,
            output_tokens=32_768,
            organization="Tokenrhythm",
            model="deepseek-v4-flash",
            reasoning=True,
        ),
    )
    set_model_cost(
        "openai/deepseek-v4-flash",
        ModelCost(input=0.14, output=0.28, input_cache_write=0.14, input_cache_read=0.014),
    )
    dataset_path = Path(dataset)
    if not dataset_path.is_file():
        raise FileNotFoundError(
            f"Dataset not found: {dataset_path}. Run scripts/inspect/export-cases.ts first."
        )
    return Task(
        dataset=json_dataset(str(dataset_path), name="harnessdiff-three-case"),
        solver=harness_agent_solver(cli_agent),
        scorer=neo_assertion_scorer(),
        sandbox=("docker", COMPOSE_FILE),
        token_limit=SAMPLE_TOKEN_LIMIT,
        cost_limit=SAMPLE_COST_LIMIT_USD,
    )


@task
def neo_harnessdiff(dataset: str = DEFAULT_DATASET) -> Task:
    return _task_for(neo_cli_agent(), dataset)


@task
def codex_harnessdiff(dataset: str = DEFAULT_DATASET) -> Task:
    return _task_for(_lifecycle_agent("codex", _codex_agent), dataset)


@task
def kimi_harnessdiff(dataset: str = DEFAULT_DATASET) -> Task:
    return _task_for(_lifecycle_agent("kimi", _kimi_agent), dataset)


@task
def grok_harnessdiff(dataset: str = DEFAULT_DATASET) -> Task:
    return _task_for(grok_cli_agent(), dataset)


@task
def opencode_harnessdiff(dataset: str = DEFAULT_DATASET) -> Task:
    return _task_for(_lifecycle_agent("opencode", _opencode_agent), dataset)


@task
def neo_five_case(dataset: str = DEFAULT_DATASET) -> Task:
    """Compatibility task name for the earlier Neo-only entrypoint."""
    return neo_harnessdiff(dataset)

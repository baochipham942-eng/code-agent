"""Inspect tasks for same-model Neo/Codex/Kimi/Grok harness comparison."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, Callable

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
            runtime["config_isolation"] = {
                "process_home": str(isolated_home),
                "workspace": str(workspace),
            }
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


def _kimi_agent(workspace: str, isolated_home: str) -> Agent:
    kimi_home = f"{isolated_home}/.kimi-code"
    return kimi_code(
        cwd=workspace,
        version="sandbox",
        sandbox=None,
        env={"HOME": isolated_home, "KIMI_CODE_HOME": kimi_home},
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
        session_id = f"inspect-{uuid.uuid4()}"
        async with sandbox_agent_bridge(state, sandbox="default") as bridge:
            for prompt in prompts:
                result = await sandbox().exec(
                    cmd=[
                        "node", NEO_CLI, "--project", workspace,
                        "--provider", "openai", "--model", "inspect",
                        "--output-format", "text", "run", prompt,
                        "--session", session_id, "--dangerously-skip-permissions",
                    ],
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
            runtime["follow_up_prompts_sent"] = prompts[1:]
            store().set("harness_runtime", runtime)
            return bridge.state

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
        async with sandbox_agent_bridge(state, sandbox="default") as bridge:
            config = "\n".join([
                "[models]", 'default = "inspect"', "", "[model.inspect]",
                'model = "inspect"',
                f'base_url = "http://localhost:{bridge.port}/v1"',
                'api_key = "inspect-bridge-placeholder"',
                'api_backend = "chat_completions"',
                "context_window = 1000000", "max_completion_tokens = 32768", "",
            ])
            await sandbox().write_file(f"{grok_home}/config.toml", config)
            for index, prompt in enumerate(prompts):
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
            runtime["follow_up_prompts_sent"] = prompts[1:]
            store().set("harness_runtime", runtime)
            return bridge.state

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
                "follow_up_prompts_sent": state.metadata.get("follow_up_prompts_sent", []),
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

"""Inspect execution layer for Neo's fixed five-case pure-text slice."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from inspect_ai import Task, task
from inspect_ai.agent import Agent, AgentState, agent, sandbox_agent_bridge
from inspect_ai.dataset import json_dataset
from inspect_ai.model import ChatMessageAssistant, ChatMessageTool
from inspect_ai.scorer import Score, Scorer, Target, accuracy, mean, scorer
from inspect_ai.solver import TaskState
from inspect_ai.util import sandbox

CODE_AGENT_CLI = "/app/dist/cli/index.cjs"
SCORER_CLI = "/app/scripts/inspect/score-case.ts"
DEFAULT_DATASET = ".code-agent/inspect/five-case.jsonl"


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
    turn_count = 0

    for message in messages:
        if isinstance(message, ChatMessageAssistant):
            turn_count += 1
            for call in message.tool_calls or []:
                calls[call.id] = {
                    "tool": call.function,
                    "input": call.arguments,
                }
            text = _message_text(message).strip()
            if text and not message.tool_calls:
                responses.append(text)
        elif isinstance(message, ChatMessageTool):
            call = calls.get(message.tool_call_id or "", {
                "tool": message.function or "unknown",
                "input": {},
            })
            error = str(message.error) if message.error else None
            output = _message_text(message)
            tool_executions.append({
                **call,
                "output": output,
                "success": error is None,
                **({"error": error} if error else {}),
                "duration": 0,
                "timestamp": 0,
            })
            if error:
                errors.append(error)

    return {
        "toolExecutions": tool_executions,
        "responses": responses,
        "errors": errors,
        "turnCount": turn_count,
    }


@agent
def neo_cli_agent() -> Agent:
    async def execute(state: AgentState) -> AgentState:
        async with sandbox_agent_bridge(state, sandbox="default") as bridge:
            result = await sandbox().exec(
                cmd=[
                    "node",
                    CODE_AGENT_CLI,
                    "run",
                    state.messages[-1].text,
                    "--provider",
                    "openai",
                    "--model",
                    "inspect",
                    "--dangerously-skip-permissions",
                    "--output-format",
                    "text",
                ],
                cwd="/app",
                env={
                    "OPENAI_BASE_URL": f"http://localhost:{bridge.port}/v1",
                    "OPENAI_API_KEY": "inspect-bridge-placeholder",
                },
                timeout=180,
            )
            if not result.success:
                raise RuntimeError(f"code-agent run failed: {result.stderr}")
            return bridge.state

    return execute


@scorer(metrics=[accuracy(), mean()])
def neo_assertion_scorer() -> Scorer:
    async def score(state: TaskState, target: Target) -> Score:
        test_case = state.metadata.get("case")
        if not isinstance(test_case, dict):
            raise RuntimeError("Inspect sample metadata.case is missing")

        context = extract_assertion_context(state.messages)
        request_path = f"/tmp/inspect-score-{state.sample_id}.json"
        await sandbox().write_file(
            request_path,
            json.dumps({"case": test_case, "context": context}, ensure_ascii=False),
        )
        result = await sandbox().exec(
            cmd=["/app/node_modules/.bin/tsx", SCORER_CLI, request_path, "/app"],
            cwd="/app",
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
                "neo_status": scored["status"],
                "test_id": scored["testId"],
                "tool_evidence": context["toolExecutions"],
                "assertion_result": scored,
            },
        )

    return score


@task
def neo_five_case(dataset: str = DEFAULT_DATASET) -> Task:
    dataset_path = Path(dataset)
    if not dataset_path.is_file():
        raise FileNotFoundError(
            f"Dataset not found: {dataset_path}. Run scripts/inspect/export-cases.ts first."
        )
    return Task(
        dataset=json_dataset(str(dataset_path), name="neo-subset45-five-text"),
        solver=neo_cli_agent(),
        scorer=neo_assertion_scorer(),
        sandbox=("docker", str(Path(__file__).with_name("compose.yaml"))),
    )

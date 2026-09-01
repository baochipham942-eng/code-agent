# Cross-CLI Inspect harnessdiff

The same three YAML cases, Inspect model provider, assertion scorer, Docker
sandbox, and per-sample limits are shared by Neo, Codex CLI, Kimi Code, and
Grok CLI. The Grok adapter writes an isolated custom-model config that points
its OpenAI Chat Completions backend at `sandbox_agent_bridge`.

## Preparation (no container and no model call)

```bash
npx tsx scripts/inspect/export-cases.ts
source .venv-inspect/bin/activate
python -c 'import ast, pathlib; ast.parse(pathlib.Path("scripts/inspect/neo_five_case.py").read_text())'
```

## Paid run (requires explicit approval)

Do not run these commands during the preparation stage. After approval, build
the single image containing Neo and all three external CLIs:

```bash
docker build -f scripts/inspect/Dockerfile.neo-build -t neo-cli-inspect:latest .

source .venv-inspect/bin/activate
export TOKENRHYTHM_API_KEY="$(
  CODE_AGENT_CLI_MODE=1 \
  CODE_AGENT_DATA_DIR=/Users/linchen/.code-agent \
  npx tsx -e \
    "import { getSecureStorage } from './src/host/services/core/secureStorage.ts'; process.stdout.write(getSecureStorage().getApiKey('custom-tokenrhythm') ?? '')"
)"
export OPENAI_BASE_URL="https://tokenrhythm.studio/v1"
export OPENAI_API_KEY="$TOKENRHYTHM_API_KEY"
for harness in neo codex kimi grok; do
  python scripts/inspect/run-inspect.py eval \
    "scripts/inspect/neo_five_case.py@${harness}_harnessdiff" \
    --model openai/deepseek-v4-flash \
    -M responses_api=false \
    --log-dir ".code-agent/inspect/logs/${harness}"
done
```

Each task has a 150,000-token and US$0.03 per-sample fail-closed limit. Compare
`EvalSample.model_usage` for token deltas and scorer metadata `trace`,
`tool_evidence`, and `turn_count` for implementation deltas.

The existing Neo harness can still be run against the identical IDs for a
same-product control:

```bash
npx tsx scripts/eval-ci.ts --scope full --real \
  --case-dir .claude/test-cases --ids \
  bash-ls,prompt-smoke-edit-edits-schema,multi-turn-context-memory \
  --provider custom-tokenrhythm --model deepseek-v4-flash
```

Tool calls from the bridged Neo process are stored inside model-event messages
(`assistant.tool_calls` plus `tool` role replies). They are also normalized into
each score's `metadata.tool_evidence`; an independent `ToolEvent` is not expected.

Replay the generated `.eval` transcript locally with:

```bash
inspect view start --log-dir .code-agent/inspect/logs
```

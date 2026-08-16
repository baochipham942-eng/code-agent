# Neo five-case Inspect run

This slice exports five existing YAML cases without changing their semantics,
runs Neo through `sandbox_agent_bridge` in Docker, then calls the repository's
existing assertion engine from an Inspect scorer.

```bash
npx tsx scripts/inspect/export-cases.ts
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
inspect eval scripts/inspect/neo_five_case.py \
  --model openai/deepseek-v4-flash \
  -M responses_api=false \
  --log-dir .code-agent/inspect/logs
```

Run the existing harness against the identical IDs with the same model and
endpoint, then compare each JSON result's score with the Inspect scorer metadata:

```bash
npx tsx scripts/eval-ci.ts --scope full --real \
  --case-dir .claude/test-cases --ids \
  bash-ls,bash-pwd,conv-understand-intent,error-file-not-found,prompt-smoke-read-package \
  --provider custom-tokenrhythm --model deepseek-v4-flash
```

Tool calls from the bridged Neo process are stored inside model-event messages
(`assistant.tool_calls` plus `tool` role replies). They are also normalized into
each score's `metadata.tool_evidence`; an independent `ToolEvent` is not expected.

Replay the generated `.eval` transcript locally with:

```bash
inspect view start --log-dir .code-agent/inspect/logs
```

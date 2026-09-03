# Prompt/version gate 的路径单一真值源。
# check-prompt-version-bump.sh 与 prompt evidence gate 都读取这里；不要在消费方另抄一份。
PROMPTS_DIR="src/host/prompts/"
TOOL_MODULES_DIR="src/host/tools/modules/"
VERSION_FILE="src/shared/constants/agent.ts"

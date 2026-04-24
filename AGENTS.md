# Local Workspace

This workspace inherits the always-on collaboration rules from `/Users/linchen/AGENTS.md`.

## Codex Memory Bootstrap

- For every new Codex session rooted here, load memory from `/Users/linchen/.codex/memories/`, not from any Claude memory directory
- Read `/Users/linchen/.codex/memories/MEMORY.md` first
- Then expand `/Users/linchen/.codex/memories/soul.md`, all indexed `feedback_*.md`, and `/Users/linchen/.codex/memories/daily/<today>.md`; if today's daily is missing, read the most recent file under `/Users/linchen/.codex/memories/daily/`
- If memory is still insufficient, say `我记不清，让我去翻一下。` and then inspect the relevant Codex memory files before answering
- Keep Codex memory separate from `~/.claude/projects/-Users-linchen/memory/...` unless the user explicitly asks for a Claude-side comparison
- Load project-specific repo context only after the Codex memory bootstrap

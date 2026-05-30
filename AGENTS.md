# Local Workspace

This workspace inherits the always-on collaboration rules from `/Users/linchen/AGENTS.md`.

## Codex Memory Bootstrap

- For every new Codex session rooted here, load memory from `/Users/linchen/.codex/memories/`, not from any Claude memory directory
- Read `/Users/linchen/.codex/memories/MEMORY.md` first
- At session start, expand `/Users/linchen/.codex/memories/soul.md` once; in later turns of the same live conversation, rely on existing context instead of re-reading it
- Re-expand `/Users/linchen/.codex/memories/soul.md` after context compaction, session resume, or any sign that identity/tone constraints have drifted
- Read `/Users/linchen/.codex/memories/daily/<today>.md` at session start; if today's daily is missing, read the most recent file under `/Users/linchen/.codex/memories/daily/`
- Do not bulk-expand indexed `feedback_*.md`; use `/Users/linchen/.codex/memories/MEMORY.md` keywords plus the current task to open only directly relevant feedback files
- If memory is still insufficient, say `我记不清，让我去翻一下。` and then inspect the relevant Codex memory files before answering
- Keep Codex memory separate from `~/.claude/projects/-Users-linchen/memory/...` unless the user explicitly asks for a Claude-side comparison
- Load project-specific repo context only after the Codex memory bootstrap

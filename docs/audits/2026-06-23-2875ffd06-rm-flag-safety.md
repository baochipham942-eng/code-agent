# Codex Security Audit — rm-flag-safety

**Date**: 2026-06-23
**Scope**: `fix/rm-flag-safety` (commits 221879848 + 2875ffd06)
**Reviewer**: Codex (gpt-5.5), adversarial security review
**Origin**: escalated from the coverage-planning-cron audit (Round 3) — a
pre-existing `rm` long-flag bypass across three dangerous-command detectors.

## What this branch fixes

The three dangerous-`rm` detectors only matched short flag clusters
`(-[rRf]+\s+)*`, so `rm --recursive /`, `rm -r --force /`, `rm --recursive
--force ~` slipped past **all three**:
- `src/main/security/commandSafety.ts` — `validateCommand` risk grading (primary)
- `src/main/tools/permissionClassifier.ts` — `DANGEROUS_BASH_PATTERNS` deny
- `src/main/planning/matchers.ts` — `matchDangerousBash` planning heuristic

Fix: a single shared source of truth `src/main/security/rmFlagPattern.ts`
(`RM_FLAGS` / `RM_FLAGS_REQUIRED` / `RM_HEAD`) covering short clusters, long
options (`--recursive`/`--force`), `=value` long options, the `--` separator,
any order/count, with a left word-boundary on `rm`. Reused by all three
detectors so they cannot drift apart.

## Findings & resolution

| Severity | Finding | Resolution |
|----------|---------|------------|
| — | **ReDoS** | ✅ none. Codex tested negative inputs up to ~820KB, linear, ~13ms worst. The alternation is unambiguous (`-[A-Za-z]+` can't match `--recursive`). |
| — | **Template escaping** (`\$HOME`/`\*`/`\s`/`/`) | ✅ no escaping bug found. |
| 🔴 HIGH | `=value` long option breaks the flag run → `rm --recursive --force --interactive=never /` evaded all three | ✅ fixed in `2875ffd06` — `RM_FLAG_TOKEN` long option now allows `(?:=\S+)?`. |
| 🟢 LOW | Word boundary — this branch newly expanded a pre-existing `rm`-as-substring false positive to long flags (`confirm --recursive /`) | ✅ fixed in `2875ffd06` — `RM_HEAD = (?<![\w-])rm\s+`; still catches `/bin/rm`, `\rm`, `;rm`. |
| 🟡 HIGH | **Shell-quoted / shell-expanded argv** still evades all three: `rm "-rf" /etc`, `rm --recursive --force "/etc"`, `rm -rf "${HOME}"`, `rm -rf ${HOME}` | ❌ **NOT fixed — pre-existing, escalated.** Regex cannot robustly strip quotes or expand `${HOME}`. The old regex missed these too; this branch does not make them worse. See "Recommended follow-up". |
| 🟢 LOW | Over-block — "any flag" semantics flag non-deleting modes (`rm --help *`, `rm --version /`) as dangerous | ℹ️ accepted. This is a *safe* false positive (extra confirmation), not a hole. Precise semantic-flag classification is part of the argv-tokenizer follow-up. |

## Recommended follow-up (separate decision)

Codex's core point: **regex on raw shell strings will keep losing to shell
syntax** (quoting, `${...}` expansion, wrappers, basename). The robust fix is to
replace the three regex sites with a shared `analyzeRmDanger(command)` that:
tokenizes argv, strips quotes/escapes, normalizes `~`/`$HOME`/`${HOME}`, honors
`--`, unwraps `sudo`/`command`/`env`/basename `/bin/rm`/`\rm`, and classifies
*semantic* flags (recursive/force) vs benign (`--help`/`--version`).

This is a ~150-line security-critical component with its own correctness bar and
adversarial-review needs — deliberately **not** bundled into this focused
bypass-closing PR. It is the owner's call whether to invest in it (and whether in
this PR or a dedicated follow-up).

## Net assessment

This branch is a **strict improvement**: it fully closes the reported unquoted
long-flag bypass class (the original escalation), plus `=value` flags and a
word-boundary false positive, with ReDoS-safety and escaping verified by an
independent adversarial reviewer, and 778 files / 7873 tests green with zero
regression. The remaining quoted-arg / brace-expansion class is pre-existing and
flagged honestly for a follow-up decision; this PR does not claim to close it.

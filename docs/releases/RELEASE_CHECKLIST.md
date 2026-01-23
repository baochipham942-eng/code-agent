# Release Checklist for v0.9.0

Use this checklist when all sessions have completed and the release is ready.

## Pre-Release Verification

### Session Completion
- [ ] Session A (Security) completed A1-A15
- [ ] Session B (Tools/Context) completed B1-B16
- [ ] Session C (Prompts/Hooks) completed C1-C18
- [ ] Session D (Quality) completed D1-D15

### Branch Status
- [ ] `feature/security` branch up to date
- [ ] `feature/tools-context` branch up to date
- [ ] `feature/prompts-hooks` branch up to date
- [ ] `feature/quality` branch up to date

---

## Merge Process

### 1. Merge to develop
```bash
# In main repo (not worktree)
cd ~/Downloads/ai/code-agent

# Merge Session A
git merge feature/security --no-ff -m "Merge feature/security: Security module (A1-A15)"

# Merge Session B
git merge feature/tools-context --no-ff -m "Merge feature/tools-context: Tool enhancements (B1-B16)"

# Merge Session C
git merge feature/prompts-hooks --no-ff -m "Merge feature/prompts-hooks: Prompts and hooks (C1-C18)"

# Merge Session D
git merge feature/quality --no-ff -m "Merge feature/quality: Testing and documentation (D1-D15)"
```

### 2. Resolve Conflicts
- [ ] No merge conflicts, OR
- [ ] All conflicts resolved and tested

---

## Build Verification (D12)

### Type Check
```bash
npm run typecheck
```
- [ ] Type check passes with no errors

### Build
```bash
npm run build
```
- [ ] Build completes successfully
- [ ] No build warnings (or warnings are acceptable)

### Test Suite
```bash
npm run test
```
- [ ] All tests pass
- [ ] Scaffold tests (.todo) are expected to be skipped

---

## Version Update (D11)

### package.json
```bash
# Update version
npm version 0.9.0 --no-git-tag-version
```
- [ ] Version updated to 0.9.0

### Vercel API
Update `vercel-api/api/update.ts`:
```typescript
const LATEST_VERSION = '0.9.0';
```
- [ ] API version updated

---

## Package Testing (D13)

### Build Package
```bash
# Must be in main repo, not worktree!
npm run dist:mac
```
- [ ] Package builds successfully

### Test Package
```bash
# Open the packaged app
open release/mac-arm64/Code\ Agent.app
```
- [ ] App launches without errors
- [ ] Basic functionality works (new session, send message)
- [ ] Security features work (audit log created)
- [ ] Hooks configuration loads

---

## Documentation (D14)

### Release Notes
- [ ] `docs/releases/v0.9.0.md` updated with final content
- [ ] Bug fixes section populated
- [ ] Known issues updated

### CHANGELOG
- [ ] `CHANGELOG.md` [Unreleased] section moved to [0.9.0]
- [ ] Release date added

---

## Final Release (D15)

### Commit Version Update
```bash
git add package.json package-lock.json vercel-api/api/update.ts CHANGELOG.md
git commit -m "chore: release v0.9.0"
```

### Create Tag
```bash
git tag -a v0.9.0 -m "Release v0.9.0 - Claude Code Alignment"
```

### Push
```bash
git push origin main
git push origin v0.9.0
```

### Deploy API
```bash
# Push triggers Vercel auto-deploy
# Verify deployment:
curl "https://code-agent-beta.vercel.app/api/update?action=health"
```
- [ ] API returns version 0.9.0

---

## Post-Release

### Cleanup Worktrees
```bash
git worktree remove ~/.claude-worktrees/code-agent/security
git worktree remove ~/.claude-worktrees/code-agent/tools-context
git worktree remove ~/.claude-worktrees/code-agent/prompts-hooks
git worktree remove ~/.claude-worktrees/code-agent/quality
```

### Delete Feature Branches
```bash
git branch -d feature/security
git branch -d feature/tools-context
git branch -d feature/prompts-hooks
git branch -d feature/quality
```

### Announcement
- [ ] Release notes published
- [ ] Users notified of update availability

---

## Rollback Plan

If critical issues are found:

```bash
# Revert the release commit
git revert HEAD

# Or reset to previous tag
git reset --hard v0.8.x

# Force push (requires admin)
git push --force origin main

# Update API version back
# Edit vercel-api/api/update.ts
```

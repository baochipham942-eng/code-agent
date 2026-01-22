# Changelog

All notable changes to Code Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Security Module (Session A: A1-A5)
- **Command Monitor** (`src/main/security/commandMonitor.ts`)
  - Pre-execution validation for shell commands
  - Configurable blocked/warning patterns
  - Post-execution auditing

- **Sensitive Information Detector** (`src/main/security/sensitiveDetector.ts`)
  - Detection of 20+ sensitive patterns
  - API keys, AWS secrets, GitHub tokens, private keys
  - Password and database URL detection

- **Audit Logger** (`src/main/security/auditLogger.ts`)
  - JSONL audit log files at `~/.code-agent/audit/`
  - Tool execution recording with duration and status
  - Query support by time range, session, tool name

- **Log Masker** (`src/main/security/logMasker.ts`)
  - Automatic masking of sensitive information in logs
  - Configurable masking patterns

#### Tool Enhancements (Session B: B1-B6)
- **File Read Tracker** (`src/main/tools/fileReadTracker.ts`)
  - Tracks file read operations
  - Enforces read-before-edit pattern
  - Records read timestamps and mtimes

- **Quote Normalizer** (`src/main/tools/utils/quoteNormalizer.ts`)
  - Converts smart/curly quotes to straight quotes
  - Enables fuzzy string matching
  - Improves edit_file reliability

- **External Modification Detector** (`src/main/tools/utils/externalModificationDetector.ts`)
  - Detects files modified outside Code Agent
  - Warns before overwriting external changes

- **Background Task Persistence** (`src/main/tools/backgroundTaskPersistence.ts`)
  - Persists running background tasks
  - Recovery after application restart

- **Enhanced Grep Parameters**
  - `-A`/`-B`/`-C` context line support
  - `--type` file type filtering

#### Prompt Enhancements (Session C: C1-C4, C8)
- **Injection Defense Rules** (`src/main/generation/prompts/rules/injection/`)
  - Core instruction source verification
  - Response verification guidelines
  - Meta-level rule protection

- **Detailed Tool Descriptions**
  - Bash tool: parameters, examples, anti-patterns
  - Edit tool: error handling, best practices
  - Task tool: subagent types, use cases

#### Hooks System (Session C: C9-C14)
- **Hook Configuration Parser** (`src/main/hooks/configParser.ts`)
  - Parse `.claude/settings.json` hooks configuration
  - Validation and error reporting

- **Script Executor** (`src/main/hooks/scriptExecutor.ts`)
  - Execute external shell scripts
  - Environment variable injection
  - Timeout handling

- **11 Event Types** (`src/main/hooks/events.ts`)
  - PreToolUse, PostToolUse, PostToolUseFailure
  - UserPromptSubmit, Stop, SubagentStop
  - PreCompact, Setup, SessionStart, SessionEnd, Notification

- **Multi-Source Hook Merging** (`src/main/hooks/merger.ts`)
  - Merge global and project-level hooks
  - Priority handling and deduplication

- **Prompt-Based Hooks** (`src/main/hooks/promptHook.ts`)
  - AI-powered hook evaluation
  - Dynamic prompt support

#### Testing Infrastructure (Session D: D1-D5)
- **Integration Test Framework** (`tests/integration/`)
  - Test environment setup utilities
  - Mock services for Electron, database, auth
  - Example tests demonstrating framework usage

- **Test Scaffolds**
  - Security module unit tests (91 tests)
  - Tool enhancement unit tests (57 tests)
  - Prompt builder tests (56 tests)
  - E2E security scenario tests (29 tests)

### Changed

- **edit_file**: Now requires file to be read first (read-before-edit)
- **edit_file**: Smart quote normalization for better string matching
- **edit_file**: Warning on external file modification
- **grep**: New `-A`, `-B`, `-C`, `--type` parameters

### Deprecated

- None

### Removed

- None

### Fixed

- None yet

### Security

- Added runtime command monitoring
- Added sensitive information detection and masking
- Added comprehensive audit logging
- Added injection defense rules to system prompts

---

## [0.9.1] - 2026-01-22

### Changed
- Version bump

---

## [0.9.0] - 2026-01-XX

> **Note**: This version is in development. See [Unreleased] for upcoming changes.

---

## [0.8.x] - Previous Releases

See git history for previous release notes.

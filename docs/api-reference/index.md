# API Reference

> **Note**: This documentation covers APIs being developed as part of the Claude Code alignment refactoring project.

## Modules

### Security Module

Runtime security monitoring, sensitive information detection, and audit logging.

- [Security API Reference](./security.md) - Command monitoring, sensitive detection, audit logging

**Key Features:**
- Command validation before execution
- 20+ sensitive information patterns
- JSONL audit logs
- Automatic log masking

---

### Tool Enhancements

Improvements to file operations and search capabilities.

- [Tool Enhancement API Reference](./tool-enhancements.md) - File tracking, quote normalization, modification detection

**Key Features:**
- Read-before-edit enforcement
- Smart quote normalization for matching
- External modification detection
- Background task persistence

---

### Hooks System

User-configurable event hooks for custom automation.

- [Hooks API Reference](./hooks.md) - Configuration, events, script execution

**Key Features:**
- 11 event types
- Shell script execution
- AI-powered prompt hooks
- Multi-source configuration merging

---

## Status

| Module | Status | Session | Tasks |
|--------|--------|---------|-------|
| Security | Scaffold | Session A | A1-A5 |
| Tool Enhancements | Scaffold | Session B | B1-B6 |
| Hooks System | Scaffold | Session C | C9-C14 |

Documentation will be completed as each session finishes their implementation.

---

## Related Documentation

- [Architecture Overview](../ARCHITECTURE.md)
- [Constitution Design](../CONSTITUTION.md)
- [Migration Guide](../migration/v0.9-upgrade.md) (when available)

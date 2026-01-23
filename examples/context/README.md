# Context Management Examples

> **Status**: SCAFFOLD - Will be completed when Session B finishes B7-B11

This directory contains examples for the Code Agent context management system.

## Overview

The context management system handles:
- Token estimation for different content types
- Incremental context compression
- Code block preservation during compression
- AI-powered summarization

## Token Estimation

Different content types have different token densities:

| Content Type | Chars/Token | Example |
|--------------|-------------|---------|
| English text | ~3.5 | Documentation, comments |
| Chinese text | ~2.0 | Chinese documentation |
| Code | ~3.0 | Source code, configs |

### Usage Example

```typescript
// TODO: Document when B7 is complete
import { estimateTokens } from './context/tokenEstimator';

const englishTokens = estimateTokens('Hello, world!');
const chineseTokens = estimateTokens('你好，世界！');
const codeTokens = estimateTokens('function hello() { return "world"; }');
```

## Compression Strategies

The context manager supports multiple compression strategies:

### Truncate

Simple truncation from the beginning of the conversation.

```json
{
  "context": {
    "compression": {
      "strategy": "truncate",
      "threshold": 100000,
      "targetRatio": 0.5
    }
  }
}
```

### AI Summary

Uses AI to generate summaries of older messages.

```json
{
  "context": {
    "compression": {
      "strategy": "ai_summary",
      "threshold": 100000,
      "targetRatio": 0.3
    }
  }
}
```

### Code Extract

Preserves code blocks while compressing prose.

```json
{
  "context": {
    "compression": {
      "strategy": "code_extract",
      "threshold": 100000,
      "preserveRecentCode": 5
    }
  }
}
```

## Code Block Preservation

During compression, code blocks are protected:

1. Recent code modifications are always preserved
2. Code block boundaries are respected (no mid-block truncation)
3. Imports and function signatures are prioritized

## Configuration

```json
// .claude/settings.json
{
  "context": {
    "maxTokens": 100000,
    "compression": {
      "enabled": true,
      "strategy": "ai_summary",
      "threshold": 80000,
      "targetRatio": 0.5
    },
    "codePreservation": {
      "enabled": true,
      "recentBlocksToKeep": 5
    }
  }
}
```

## See Also

- [Context Management API](../../docs/api-reference/context.md) (when available)
- [Token Estimation Tests](../../tests/unit/context/) (when available)

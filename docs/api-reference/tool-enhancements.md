# Tool Enhancement API Reference

> **Status**: SCAFFOLD - Will be completed when Session B finishes B1-B6

This document describes the tool enhancement APIs for Code Agent.

## Overview

Tool enhancements improve file operations and search capabilities with smart tracking, validation, and normalization features.

## Modules

### File Read Tracker (`src/main/tools/fileReadTracker.ts`)

Tracks file read operations to enforce read-before-edit and detect external modifications.

```typescript
// TODO: Document when B1 is complete
interface FileReadTracker {
  recordRead(filePath: string, mtime: number): void;
  hasBeenRead(filePath: string): boolean;
  getReadTime(filePath: string): number | undefined;
  checkExternalModification(filePath: string, currentMtime: number): boolean;
  clear(): void;
}
```

#### Methods

##### `recordRead(filePath: string, mtime: number): void`

Records that a file has been read.

**Parameters:**
- `filePath` - Absolute path to the file
- `mtime` - File modification time at read

##### `hasBeenRead(filePath: string): boolean`

Checks if a file has been read in the current session.

**Returns:**
- `true` if the file has been read

##### `checkExternalModification(filePath: string, currentMtime: number): boolean`

Detects if file was modified externally since last read.

**Returns:**
- `true` if mtime changed since recording

**Example:**
```typescript
// TODO: Add example when implemented
const tracker = new FileReadTracker();

// When reading a file
const stats = fs.statSync(filePath);
tracker.recordRead(filePath, stats.mtimeMs);

// Before editing
if (!tracker.hasBeenRead(filePath)) {
  throw new Error('File must be read before editing');
}

const currentStats = fs.statSync(filePath);
if (tracker.checkExternalModification(filePath, currentStats.mtimeMs)) {
  console.warn('Warning: File was modified externally');
}
```

---

### Quote Normalizer (`src/main/tools/utils/quoteNormalizer.ts`)

Converts smart/curly quotes to straight quotes for reliable string matching.

```typescript
// TODO: Document when B2 is complete
interface QuoteNormalizer {
  normalize(text: string): string;
  fuzzyMatch(needle: string, haystack: string): FuzzyMatchResult | null;
}

interface FuzzyMatchResult {
  matched: boolean;
  originalMatch: string;
  normalizedMatch: string;
  position: number;
}
```

#### Quote Mappings

| Smart Quote | Unicode | Normalized |
|-------------|---------|------------|
| ' (left single) | `\u2018` | `'` |
| ' (right single) | `\u2019` | `'` |
| " (left double) | `\u201C` | `"` |
| " (right double) | `\u201D` | `"` |
| ‚ (single low-9) | `\u201A` | `'` |
| „ (double low-9) | `\u201E` | `"` |

#### Methods

##### `normalize(text: string): string`

Converts all smart quotes to straight quotes.

**Example:**
```typescript
const normalizer = new QuoteNormalizer();
normalizer.normalize('"Hello World"');
// Result: '"Hello World"'
```

##### `fuzzyMatch(needle: string, haystack: string): FuzzyMatchResult | null`

Matches strings accounting for quote variations.

**Example:**
```typescript
// Matches despite different quote styles
const result = normalizer.fuzzyMatch(
  '"Hello"',      // straight quotes
  '"Hello"'       // curly quotes
);
// Result: { matched: true, position: 0, ... }
```

---

### External Modification Detector (`src/main/tools/utils/externalModificationDetector.ts`)

Detects when files have been modified outside the current session.

```typescript
// TODO: Document when B3 is complete
interface ExternalModificationDetector {
  snapshot(filePath: string): FileSnapshot;
  detect(filePath: string, previousSnapshot: FileSnapshot): ModificationResult;
}

interface FileSnapshot {
  path: string;
  mtime: number;
  size: number;
  hash?: string;
}

interface ModificationResult {
  modified: boolean;
  changes: {
    mtimeChanged: boolean;
    sizeChanged: boolean;
    contentChanged?: boolean;
  };
}
```

#### Methods

##### `snapshot(filePath: string): FileSnapshot`

Creates a snapshot of file state.

##### `detect(filePath: string, previousSnapshot: FileSnapshot): ModificationResult`

Compares current state with previous snapshot.

**Example:**
```typescript
const detector = new ExternalModificationDetector();

// Take snapshot when reading
const snapshot = detector.snapshot('/path/to/file.ts');

// Check before editing
const result = detector.detect('/path/to/file.ts', snapshot);
if (result.modified) {
  console.warn('File was modified externally!');
  if (result.changes.contentChanged) {
    console.warn('Content has changed - please re-read the file');
  }
}
```

---

### Background Task Persistence (`src/main/tools/backgroundTaskPersistence.ts`)

Persists running background task information for recovery after restart.

```typescript
// TODO: Document when B4 is complete
interface BackgroundTaskPersistence {
  save(task: BackgroundTask): Promise<void>;
  load(): Promise<BackgroundTask[]>;
  remove(taskId: string): Promise<void>;
  cleanup(): Promise<void>;
}

interface BackgroundTask {
  id: string;
  type: 'shell' | 'process' | 'agent';
  command?: string;
  pid?: number;
  startTime: number;
  workingDirectory: string;
  sessionId: string;
}
```

#### Storage Location

Tasks are stored at `~/.code-agent/background-tasks.json`

---

## Integration with edit_file

The edit_file tool integrates these enhancements:

```typescript
// Simplified integration
async function editFile(args: EditFileArgs) {
  const { filePath, oldString, newString } = args;

  // 1. Check if file was read
  if (!fileReadTracker.hasBeenRead(filePath)) {
    return {
      success: false,
      error: 'File must be read before editing. Use read_file first.',
    };
  }

  // 2. Check for external modifications
  const stats = fs.statSync(filePath);
  if (fileReadTracker.checkExternalModification(filePath, stats.mtimeMs)) {
    return {
      success: false,
      error: 'File was modified externally. Please re-read the file.',
    };
  }

  // 3. Try exact match first
  let content = fs.readFileSync(filePath, 'utf-8');
  let matchIndex = content.indexOf(oldString);

  // 4. Try fuzzy match with quote normalization
  if (matchIndex === -1) {
    const fuzzyResult = quoteNormalizer.fuzzyMatch(oldString, content);
    if (fuzzyResult) {
      matchIndex = fuzzyResult.position;
      // Use the original match for replacement
      content = content.replace(fuzzyResult.originalMatch, newString);
    }
  }

  // 5. Perform edit
  if (matchIndex === -1) {
    return { success: false, error: 'Old string not found in file' };
  }

  content = content.replace(oldString, newString);
  fs.writeFileSync(filePath, content);

  return { success: true };
}
```

---

## Integration with grep

Enhanced grep parameters (B6):

```typescript
interface GrepArgs {
  pattern: string;
  path?: string;
  // New parameters
  beforeContext?: number;  // -B lines before match
  afterContext?: number;   // -A lines after match
  context?: number;        // -C lines before and after
  fileType?: string;       // --type filter (js, ts, py, etc.)
}
```

**Example:**
```typescript
// Search with context
grep({
  pattern: 'function handleError',
  path: 'src/',
  afterContext: 5,         // Show 5 lines after match
  fileType: 'ts',          // Only TypeScript files
});
```

---

## See Also

- [Tool Enhancement Test Scaffolds](../../tests/unit/tools/enhancements/)
- [Edit File Implementation](../../src/main/tools/gen1/edit_file.ts)
- [Grep Implementation](../../src/main/tools/gen2/grep.ts)

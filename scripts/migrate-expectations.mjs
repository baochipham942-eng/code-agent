#!/usr/bin/env node
// ============================================================================
// migrate-expectations.mjs
// Converts old `expect:` format to new `expectations:` format in test YAML files
// Idempotent: skips cases that already have `expectations:`
// ============================================================================

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const TEST_DIR = path.resolve(import.meta.dirname, '../.claude/test-cases');

// ---------------------------------------------------------------------------
// Conversion rules: expect field → expectations entries
// ---------------------------------------------------------------------------

function generateExpectations(expect) {
  const exps = [];

  // --- tool_called ---
  if (expect.tool_called) {
    const tools = Array.isArray(expect.tool_called) ? expect.tool_called : [expect.tool_called];
    for (const tool of tools) {
      exps.push({
        type: 'tool_called',
        description: `应调用 ${tool} 工具`,
        weight: 0.8,
        params: { tool },
      });
    }
  }

  // --- response_contains ---
  if (expect.response_contains) {
    const items = Array.isArray(expect.response_contains) ? expect.response_contains : [expect.response_contains];
    for (const text of items) {
      exps.push({
        type: 'response_contains',
        description: `响应应包含 '${text}'`,
        weight: 0.8,
        params: { text },
      });
    }
  }

  // --- response_not_contains ---
  if (expect.response_not_contains) {
    const items = Array.isArray(expect.response_not_contains) ? expect.response_not_contains : [expect.response_not_contains];
    for (const text of items) {
      exps.push({
        type: 'response_not_contains',
        description: `响应不应包含 '${text}'`,
        weight: 0.8,
        params: { text },
      });
    }
  }

  // --- content_contains ---
  if (expect.content_contains) {
    const items = Array.isArray(expect.content_contains) ? expect.content_contains : [expect.content_contains];
    for (const text of items) {
      exps.push({
        type: 'content_contains',
        description: `输出应包含 '${text}'`,
        weight: 0.8,
        params: { text },
      });
    }
  }

  // --- content_not_contains ---
  if (expect.content_not_contains) {
    const items = Array.isArray(expect.content_not_contains) ? expect.content_not_contains : [expect.content_not_contains];
    for (const text of items) {
      exps.push({
        type: 'content_not_contains',
        description: `输出不应包含 '${text}'`,
        weight: 0.8,
        params: { text },
      });
    }
  }

  // --- file_exists ---
  if (expect.file_exists) {
    const paths = Array.isArray(expect.file_exists) ? expect.file_exists : [expect.file_exists];
    for (const p of paths) {
      exps.push({
        type: 'file_exists',
        description: `文件应存在: ${p}`,
        weight: 1.0,
        critical: true,
        params: { path: p },
      });
    }
  }

  // --- files_created → file_exists ---
  if (expect.files_created) {
    const files = Array.isArray(expect.files_created) ? expect.files_created : [expect.files_created];
    for (const f of files) {
      exps.push({
        type: 'file_exists',
        description: `文件应存在: ${f}`,
        weight: 1.0,
        critical: true,
        params: { path: f },
      });
    }
  }

  // --- file_contains → content_contains (per file, per text) ---
  if (expect.file_contains) {
    for (const [filePath, texts] of Object.entries(expect.file_contains)) {
      const items = Array.isArray(texts) ? texts : [texts];
      for (const text of items) {
        exps.push({
          type: 'content_contains',
          description: `文件 ${filePath} 应包含 '${text}'`,
          weight: 0.8,
          params: { path: filePath, contains: String(text) },
        });
      }
    }
  }

  // --- file_not_contains → content_not_contains ---
  if (expect.file_not_contains) {
    for (const [filePath, texts] of Object.entries(expect.file_not_contains)) {
      const items = Array.isArray(texts) ? texts : [texts];
      for (const text of items) {
        exps.push({
          type: 'content_not_contains',
          description: `文件 ${filePath} 不应包含 '${text}'`,
          weight: 0.8,
          params: { path: filePath, not_contains: String(text) },
        });
      }
    }
  }

  // --- files_not_exist → file_not_exists ---
  if (expect.files_not_exist) {
    const files = Array.isArray(expect.files_not_exist) ? expect.files_not_exist : [expect.files_not_exist];
    for (const f of files) {
      exps.push({
        type: 'file_not_exists',
        description: `文件不应存在: ${f}`,
        weight: 0.8,
        params: { path: f },
      });
    }
  }

  // --- error_handled ---
  if (expect.error_handled) {
    exps.push({
      type: 'error_handled',
      description: '应优雅处理错误',
      weight: 0.8,
      params: {},
    });
  }

  // --- tool_output_contains ---
  if (expect.tool_output_contains) {
    const items = Array.isArray(expect.tool_output_contains) ? expect.tool_output_contains : [expect.tool_output_contains];
    for (const item of items) {
      if (typeof item === 'object' && item.tool && item.text) {
        exps.push({
          type: 'tool_output_contains',
          description: `工具 ${item.tool} 输出应包含 '${item.text}'`,
          weight: 0.8,
          params: { tool: item.tool, text: item.text },
        });
      }
    }
  }

  // --- max_turns ---
  if (expect.max_turns != null) {
    exps.push({
      type: 'max_turns',
      description: `应在 ${expect.max_turns} 轮内完成`,
      weight: 0.3,
      params: { max: expect.max_turns },
    });
  }

  // --- min_tool_calls ---
  if (expect.min_tool_calls != null) {
    exps.push({
      type: 'min_tool_calls',
      description: `至少应调用 ${expect.min_tool_calls} 次工具`,
      weight: 0.3,
      params: { min: expect.min_tool_calls },
    });
  }

  // --- max_tool_calls ---
  if (expect.max_tool_calls != null) {
    exps.push({
      type: 'max_tool_calls',
      description: `最多调用 ${expect.max_tool_calls} 次工具`,
      weight: 0.3,
      params: { max: expect.max_tool_calls },
    });
  }

  // --- asks_clarification ---
  if (expect.asks_clarification) {
    exps.push({
      type: 'response_contains',
      description: '应提出澄清问题',
      weight: 0.8,
      params: { text: '?' },
    });
  }

  // --- uses_todo ---
  if (expect.uses_todo) {
    exps.push({
      type: 'tool_called',
      description: '应使用 Todo 列表工具',
      weight: 0.8,
      params: { tool: 'todo' },
    });
  }

  // --- no_crash (baseline, always add if not already present) ---
  const hasNoCrash = exps.some(e => e.type === 'no_crash');
  if (!hasNoCrash) {
    exps.push({
      type: 'no_crash',
      description: '不应崩溃',
      weight: 1.0,
      critical: true,
      params: {},
    });
  }

  return exps;
}

// ---------------------------------------------------------------------------
// YAML text-level insertion (preserves comments, formatting, ordering)
// ---------------------------------------------------------------------------

/**
 * Insert `expectations:` block right after the `expect:` block for a given case,
 * working on raw YAML text to preserve comments and formatting.
 */
function insertExpectationsIntoYaml(yamlText, caseId, expectations) {
  const lines = yamlText.split('\n');

  // Phase 1: Find the `expect:` line for this case
  let expectLineIdx = -1;
  let expectIndent = -1;
  let foundCase = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect `- id: xxx`
    const idMatch = line.match(/^(\s+)- id:\s*(.+)/);
    if (idMatch) {
      if (foundCase) break; // we passed the target case without finding expect
      if (idMatch[2].trim() === caseId) {
        foundCase = true;
      }
      continue;
    }

    if (!foundCase) continue;

    // Within the target case, look for `expect:`
    const expectMatch = line.match(/^(\s+)expect:/);
    if (expectMatch) {
      expectLineIdx = i;
      expectIndent = expectMatch[1].length;
      break;
    }
  }

  if (expectLineIdx === -1 || expectIndent === -1) {
    return null; // no expect: found for this case
  }

  // Phase 2: Find end of the expect block (first non-blank, non-comment line at ≤ expectIndent)
  let insertionIdx = -1;
  for (let i = expectLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const currentIndent = line.length - line.trimStart().length;
    if (currentIndent <= expectIndent) {
      // Check if expectations: already exists right here
      if (line.trim().startsWith('expectations:')) {
        return null; // already migrated
      }
      insertionIdx = i;
      break;
    }
  }

  // If we never exited (expect block goes to EOF)
  if (insertionIdx === -1) {
    insertionIdx = lines.length;
  }

  // Build the expectations YAML block
  const indent = ' '.repeat(expectIndent);
  const expLines = [`${indent}expectations:`];
  for (const exp of expectations) {
    expLines.push(`${indent}  - type: ${exp.type}`);
    expLines.push(`${indent}    description: "${exp.description}"`);
    expLines.push(`${indent}    weight: ${exp.weight}`);
    if (exp.critical) {
      expLines.push(`${indent}    critical: true`);
    }
    // params
    if (Object.keys(exp.params).length === 0) {
      expLines.push(`${indent}    params: {}`);
    } else {
      expLines.push(`${indent}    params:`);
      for (const [key, val] of Object.entries(exp.params)) {
        if (typeof val === 'string') {
          // Use quotes for strings
          expLines.push(`${indent}      ${key}: "${val}"`);
        } else {
          expLines.push(`${indent}      ${key}: ${val}`);
        }
      }
    }
  }

  lines.splice(insertionIdx, 0, ...expLines);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const files = fs.readdirSync(TEST_DIR).filter(f => f.endsWith('.yaml'));
  let totalConverted = 0;
  let totalSkipped = 0;
  let totalFiles = 0;

  for (const file of files) {
    const filePath = path.join(TEST_DIR, file);
    let yamlText = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(yamlText);

    if (!parsed || !parsed.cases) {
      console.log(`⏭ ${file}: no cases found, skipping`);
      continue;
    }

    totalFiles++;
    let fileConverted = 0;

    for (const testCase of parsed.cases) {
      if (!testCase.expect) {
        continue; // no expect, skip
      }
      if (testCase.expectations) {
        totalSkipped++;
        continue; // already migrated
      }

      const expectations = generateExpectations(testCase.expect);
      if (expectations.length === 0) {
        continue;
      }

      const newText = insertExpectationsIntoYaml(yamlText, testCase.id, expectations);
      if (newText) {
        yamlText = newText;
        fileConverted++;
        totalConverted++;
      } else {
        console.log(`  ⚠ ${testCase.id}: could not find insertion point`);
      }
    }

    if (fileConverted > 0) {
      fs.writeFileSync(filePath, yamlText, 'utf-8');
      console.log(`✅ ${file}: converted ${fileConverted} cases`);
    } else {
      console.log(`⏭ ${file}: 0 cases to convert`);
    }
  }

  console.log('');
  console.log(`=== Migration Summary ===`);
  console.log(`Files processed: ${totalFiles}`);
  console.log(`Cases converted: ${totalConverted}`);
  console.log(`Cases already migrated (skipped): ${totalSkipped}`);
  console.log(`Total: ${totalConverted + totalSkipped}`);
}

main();

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MODEL_ROOTS = [
  path.resolve('src/host/model/providers'),
  path.resolve('src/host/model/adapters'),
];

function listTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

interface Candidate {
  file: string;
  line: number;
  kind: string;
  implementation: string;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function enclosingFunctionOrBlock(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node;
  while (current.parent) {
    if (ts.isFunctionLike(current.parent) || ts.isBlock(current.parent)) return current.parent;
    current = current.parent;
  }
  return node;
}

function collectCandidates(file: string): Candidate[] {
  const sourceText = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const candidates: Candidate[] = [];

  function add(node: ts.Node, kind: string, implementationNode: ts.Node): void {
    candidates.push({
      file: path.relative(process.cwd(), file),
      line: lineOf(source, node),
      kind,
      implementation: implementationNode.getText(source),
    });
  }

  function visit(node: ts.Node): void {
    // Typed accumulators are the main construction pattern: `const toolCalls: ToolCall[] = ...`
    if (ts.isVariableDeclaration(node) && node.type?.getText(source).replace(/\s/g, '') === 'ToolCall[]') {
      add(node, 'ToolCall[] accumulator', enclosingFunctionOrBlock(node));
    }

    // Provider parsers also assign constructed calls directly onto ModelResponse.toolCalls.
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && node.left.name.text === 'toolCalls'
    ) {
      add(node, 'toolCalls assignment', node.right);
    }

    // Shared constructors may return ToolCall directly instead of using a typed array.
    if (ts.isFunctionDeclaration(node) && node.type?.getText(source) === 'ToolCall' && node.body) {
      add(node, 'ToolCall return', node.body);
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return candidates;
}

describe('tool-call metadata extraction static contract', () => {
  it('routes every provider/adapter ToolCall construction through extractToolCallMeta', () => {
    const candidates = MODEL_ROOTS.flatMap(listTypeScriptFiles).flatMap(collectCandidates);

    // Fail closed: a refactor that breaks candidate discovery must not silently turn this gate green.
    expect(candidates.length, 'ToolCall construction scanner matched 0 candidates').toBeGreaterThan(0);

    const violations = candidates.filter(({ implementation }) => {
      return !implementation.includes('extractToolCallMeta')
        && !implementation.includes('buildToolCallFromAccumulator');
    });

    expect(
      violations.map(({ file, line, kind }) => `${file}:${line} (${kind})`),
      `ToolCall construction bypasses extractToolCallMeta:\n${violations
        .map(({ file, line, kind }) => `- ${file}:${line} (${kind})`)
        .join('\n')}`,
    ).toEqual([]);
  });
});

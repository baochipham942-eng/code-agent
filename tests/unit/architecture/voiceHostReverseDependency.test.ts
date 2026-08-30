import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const VOICE_ROOT = path.join(REPO_ROOT, 'src/host/services/voice');
const GUARDED_ROOTS = [
  path.join(REPO_ROOT, 'src/host/agent'),
  path.join(REPO_ROOT, 'src/host/tools'),
];

interface Violation {
  file: string;
  line: number;
  specifier: string;
}

function listTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [fullPath] : [];
  });
}

function importSpecifier(node: ts.Node): ts.StringLiteral | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier
      : undefined;
  }
  if (
    ts.isCallExpression(node)
    && node.arguments.length === 1
    && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    && ts.isStringLiteral(node.arguments[0])
  ) {
    return node.arguments[0];
  }
  return undefined;
}

function collectViolations(file: string, sourceText = fs.readFileSync(file, 'utf8')): Violation[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    const specifierNode = importSpecifier(node);
    if (specifierNode?.text.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), specifierNode.text);
      if (resolved === VOICE_ROOT || resolved.startsWith(`${VOICE_ROOT}${path.sep}`)) {
        violations.push({
          file: path.relative(REPO_ROOT, file),
          line: source.getLineAndCharacterOfPosition(specifierNode.getStart(source)).line + 1,
          specifier: specifierNode.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

describe('agent/tools -> services/voice reverse dependency boundary', () => {
  it('has zero static, dynamic, re-export, or require dependencies', () => {
    const files = GUARDED_ROOTS.flatMap(listTypeScriptFiles);
    expect(files.length, 'guarded roots unexpectedly contain no TypeScript files').toBeGreaterThan(0);
    const violations = files.flatMap((file) => collectViolations(file));
    expect(
      violations,
      `host core imports voice implementation:\n${violations
        .map((item) => `- ${item.file}:${item.line} -> ${item.specifier}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('mutation guard catches a restored direct voice import', () => {
    const virtualFile = path.join(REPO_ROOT, 'src/host/agent/runtime/mutant.ts');
    expect(collectViolations(
      virtualFile,
      "import { resolveVoiceWorkOutcome } from '../../services/voice/voiceWorkEvidence';\n",
    )).toEqual([{
      file: 'src/host/agent/runtime/mutant.ts',
      line: 1,
      specifier: '../../services/voice/voiceWorkEvidence',
    }]);
  });
});

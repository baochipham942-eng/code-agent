import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = path.join(repoRoot, 'src/host/internalFeatures/internalSdkVersion.ts');
const hostSdkFile = path.join(repoRoot, 'src/host/internalFeatures/internalHostSdk.ts');
const rendererSdkFile = path.join(repoRoot, 'src/renderer/internalFeatures/internalSdk.ts');
const checkOnly = process.argv.includes('--check');

interface ContractRow {
  module: string;
  exports: string[];
}

function createContractProgram(): { checker: ts.TypeChecker; options: ts.CompilerOptions; program: ts.Program } {
  const configPath = path.join(repoRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  return { checker: program.getTypeChecker(), options: parsed.options, program };
}

function collectContractRows(
  sdkFile: string,
  prefix: '@host/' | '@renderer/',
  context: ReturnType<typeof createContractProgram>,
): ContractRow[] {
  const sdkSource = context.program.getSourceFile(sdkFile);
  if (!sdkSource) throw new Error(`SDK table is outside the TypeScript program: ${path.relative(repoRoot, sdkFile)}`);

  const namespaceImports = new Map<string, string>();
  for (const statement of sdkSource.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const namespaceImport = statement.importClause?.namedBindings;
    if (namespaceImport && ts.isNamespaceImport(namespaceImport)) {
      namespaceImports.set(namespaceImport.name.text, statement.moduleSpecifier.text);
    }
  }

  const rows: ContractRow[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)
      && node.name.text.startsWith(prefix) && ts.isIdentifier(node.initializer)) {
      const sourceSpecifier = namespaceImports.get(node.initializer.text);
      if (!sourceSpecifier) throw new Error(`SDK module ${node.name.text} does not point at a namespace import`);
      const resolved = ts.resolveModuleName(
        sourceSpecifier,
        sdkFile,
        context.options,
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (!resolved) throw new Error(`Cannot resolve SDK module ${node.name.text} from ${sourceSpecifier}`);
      const target = context.program.getSourceFile(resolved);
      const symbol = target && context.checker.getSymbolAtLocation(target);
      if (!target || !symbol) throw new Error(`Cannot inspect exports for SDK module ${node.name.text}`);
      const exports = context.checker.getExportsOfModule(symbol).map((item) => item.getName()).sort();
      rows.push({ module: node.name.text, exports });
    }
    ts.forEachChild(node, visit);
  };
  visit(sdkSource);

  if (rows.length === 0) throw new Error(`SDK table has no ${prefix} modules: ${path.relative(repoRoot, sdkFile)}`);
  return rows.sort((left, right) => left.module.localeCompare(right.module));
}

function contractHash(rows: ContractRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 8);
}

function readRecordedVersions(source: string): { host: string; renderer: string } {
  const host = source.match(/\bhost:\s*'([^']+)'/u)?.[1];
  const renderer = source.match(/\brenderer:\s*'([^']+)'/u)?.[1];
  if (!host || !renderer) throw new Error('INTERNAL_SDK_VERSION must declare host and renderer string values');
  return { host, renderer };
}

const context = createContractProgram();
const expectedHost = contractHash(collectContractRows(hostSdkFile, '@host/', context));
const rendererAvailable = fs.existsSync(rendererSdkFile);
const expectedRenderer = rendererAvailable
  ? contractHash(collectContractRows(rendererSdkFile, '@renderer/', context))
  : null;
const source = fs.readFileSync(versionFile, 'utf8');
const recorded = readRecordedVersions(source);

if (checkOnly) {
  let failed = false;
  if (recorded.host !== expectedHost) {
    console.error(`[internal-sdk-hash] host mismatch: recorded=${recorded.host} expected=${expectedHost}`);
    failed = true;
  }
  if (expectedRenderer && recorded.renderer !== expectedRenderer) {
    console.error(`[internal-sdk-hash] renderer mismatch: recorded=${recorded.renderer} expected=${expectedRenderer}`);
    failed = true;
  } else if (!expectedRenderer) {
    console.log('[internal-sdk-hash] renderer table pending; renderer check skipped until L3');
  }
  if (failed) process.exit(1);
  console.log(`[internal-sdk-hash] ok host=${expectedHost} renderer=${expectedRenderer ?? 'pending'}`);
} else {
  const next = source
    .replace(/\bhost:\s*'[^']+'/u, `host: '${expectedHost}'`)
    .replace(/\brenderer:\s*'[^']+'/u, `renderer: '${expectedRenderer ?? 'pending'}'`);
  fs.writeFileSync(versionFile, next, 'utf8');
  console.log(`[internal-sdk-hash] updated host=${expectedHost} renderer=${expectedRenderer ?? 'pending'}`);
}

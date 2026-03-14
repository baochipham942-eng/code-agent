import fs from 'fs';
import path from 'path';
import {
  finishWithError,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';

function usage(): void {
  console.log(`App-host office smoke

Usage:
  npm run acceptance:app-host-office -- [command] [options]

Commands:
  smoke
  exec --tool <name> [--params <json> | --params-file <path>] [--allow-write]

Options:
  --base-url <url>   App-host base URL. Default: http://127.0.0.1:8080
  --token <token>    Optional auth token. If omitted, try CODE_AGENT_TOKEN env, then page HTML.
  --project <path>   Optional project root passed to the host executor.
  --session <id>     Optional session id.
  --json             Print JSON only.
  --help             Show this help.
`);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function resolveToken(baseUrl: string, explicitToken?: string): Promise<string> {
  if (explicitToken?.trim()) return explicitToken.trim();
  if (process.env.CODE_AGENT_TOKEN?.trim()) return process.env.CODE_AGENT_TOKEN.trim();

  const response = await fetch(`${baseUrl}/`, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${baseUrl}/ for auth token: ${response.status}`);
  }

  const html = await response.text();
  const match = html.match(/window\.__CODE_AGENT_TOKEN__="([^"]+)"/);
  if (match?.[1]) {
    return match[1];
  }

  throw new Error('Unable to resolve auth token. Pass --token or export CODE_AGENT_TOKEN.');
}

function parseParams(args: ReturnType<typeof parseArgs>): Record<string, unknown> {
  const paramsFile = getStringOption(args, 'params-file');
  const paramsString = getStringOption(args, 'params');

  if (paramsFile) {
    const resolvedPath = path.resolve(paramsFile);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`params file does not exist: ${resolvedPath}`);
    }
    return parseJsonObject(fs.readFileSync(resolvedPath, 'utf-8'), `params file ${resolvedPath}`);
  }

  if (paramsString) {
    return parseJsonObject(paramsString, '--params');
  }

  return {};
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON.`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

async function postJson(
  baseUrl: string,
  token: string,
  endpoint: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = typeof data?.error === 'string'
      ? data.error
      : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const command = args.positionals[0] || 'smoke';
  const baseUrl = normalizeBaseUrl(getStringOption(args, 'base-url') || 'http://127.0.0.1:8080');
  const token = await resolveToken(baseUrl, getStringOption(args, 'token'));
  const project = getStringOption(args, 'project');
  const sessionId = getStringOption(args, 'session');
  const json = hasFlag(args, 'json');

  if (command === 'smoke') {
    const result = await postJson(baseUrl, token, '/api/dev/smoke/office', {
      project,
      sessionId,
    }) as {
      ok: boolean;
      project: string;
      sessionId: string;
      steps: Array<{
        id: string;
        tool: string;
        success: boolean;
        passed: boolean;
        detail: string;
      }>;
    };

    if (json) {
      printJson(result);
      return;
    }

    printKeyValue('App-Host Office Smoke', [
      ['baseUrl', baseUrl],
      ['project', result.project],
      ['sessionId', result.sessionId],
      ['ok', result.ok],
      ['steps', result.steps.length],
    ]);

    console.log('\nSteps');
    for (const step of result.steps) {
      console.log(`- ${step.id}: ${step.passed ? 'PASS' : 'FAIL'} | ${step.tool} | ${step.detail}`);
    }

    if (!result.ok) {
      process.exit(1);
    }
    return;
  }

  if (command === 'exec') {
    const tool = getStringOption(args, 'tool');
    if (!tool) {
      throw new Error('exec requires --tool');
    }

    const result = await postJson(baseUrl, token, '/api/dev/exec-tool', {
      tool,
      params: parseParams(args),
      project,
      sessionId,
      allowWrite: hasFlag(args, 'allow-write'),
    });

    if (json) {
      printJson(result);
      return;
    }

    const typed = result as {
      tool: string;
      project: string;
      sessionId: string;
      success: boolean;
      output?: string;
      error?: string;
      result?: unknown;
    };

    printKeyValue('App-Host Exec Tool', [
      ['baseUrl', baseUrl],
      ['tool', typed.tool],
      ['project', typed.project],
      ['sessionId', typed.sessionId],
      ['success', typed.success],
    ]);

    if (typed.output) {
      console.log(`\n${typed.output}`);
    } else if (typed.result !== undefined) {
      console.log(`\n${JSON.stringify(typed.result, null, 2)}`);
    }

    if (!typed.success) {
      throw new Error(typed.error || `Tool ${typed.tool} failed.`);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

run().catch(finishWithError);

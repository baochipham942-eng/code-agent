// ============================================================================
// Optional PII Entity Detector
// ============================================================================
//
// Model-based PII detection is intentionally opt-in. The deterministic guard is
// the default path; entity detection augments share/model-context surfaces only.
// ============================================================================

import { spawn } from 'child_process';
import { createLogger } from '../services/infra/logger';
import type { SensitiveDataGuardOptions } from './sensitiveDataGuard';

const logger = createLogger('PiiEntityDetector');

export interface PiiEntity {
  start: number;
  end: number;
  label: string;
  score?: number;
  text?: string;
}

export interface PiiEntityDetectionRequest {
  text: string;
  labels: string[];
  threshold: number;
  modelPath?: string;
  surface: SensitiveDataGuardOptions['surface'];
  mode: SensitiveDataGuardOptions['mode'];
}

export interface PiiEntityDetector {
  readonly id: string;
  detect(request: PiiEntityDetectionRequest): Promise<PiiEntity[]>;
}

interface PiiEntityDetectorConfig {
  enabled: boolean;
  provider: string;
  labels: string[];
  threshold: number;
  timeoutMs: number;
  maxChars: number;
  command?: string;
  pythonPath?: string;
  modelPath?: string;
}

const DEFAULT_LABELS = [
  'person',
  'organization',
  'location',
  'address',
  'phone number',
  'email',
  'credit card number',
  'bank account number',
  'iban',
  'passport number',
  'driver license',
  'national id',
  'tax id',
  'social security number',
  'date of birth',
  'medical record number',
  'health insurance id',
  'ip address',
  'username',
];

let detectorOverride: PiiEntityDetector | null | undefined;
let configuredDetector: PiiEntityDetector | null | undefined;

export function shouldUsePiiEntityDetection(options: SensitiveDataGuardOptions): boolean {
  if (options.mode !== 'share' && options.mode !== 'model-context') return false;
  if (options.surface === 'telemetry') return false;
  return getPiiEntityDetectorConfig().enabled;
}

export async function detectPiiEntities(
  text: string,
  options: SensitiveDataGuardOptions,
): Promise<PiiEntity[]> {
  if (!text.trim() || !shouldUsePiiEntityDetection(options)) return [];

  const config = getPiiEntityDetectorConfig();
  const detector = getConfiguredPiiEntityDetector(config);
  if (!detector) return [];

  const limitedText = text.length > config.maxChars ? text.slice(0, config.maxChars) : text;

  try {
    return await detector.detect({
      text: limitedText,
      labels: config.labels,
      threshold: config.threshold,
      modelPath: config.modelPath,
      surface: options.surface,
      mode: options.mode,
    });
  } catch (error) {
    logger.debug('PII entity detector failed; falling back to deterministic guard', {
      provider: detector.id,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export function redactPiiEntities(
  text: string,
  entities: PiiEntity[],
  threshold = getPiiEntityDetectorConfig().threshold,
): string {
  const valid = entities
    .filter((entity) =>
      Number.isFinite(entity.start)
      && Number.isFinite(entity.end)
      && entity.start >= 0
      && entity.end > entity.start
      && entity.end <= text.length
      && (entity.score === undefined || entity.score >= threshold),
    )
    .sort((a, b) => b.start - a.start);

  let redacted = text;
  for (const entity of valid) {
    const label = normalizeEntityLabel(entity.label);
    redacted = `${redacted.slice(0, entity.start)}[PII:${label}]${redacted.slice(entity.end)}`;
  }
  return redacted;
}

export function getPiiEntityDetectorConfig(env: NodeJS.ProcessEnv = process.env): PiiEntityDetectorConfig {
  const provider = (env.CODE_AGENT_PII_ENTITY_DETECTOR || '').trim().toLowerCase();
  const command = env.CODE_AGENT_GLINER_PII_COMMAND?.trim() || env.CODE_AGENT_PII_ENTITY_COMMAND?.trim();
  const pythonPath = env.CODE_AGENT_GLINER_PII_RUNNER_PYTHON?.trim() || env.CODE_AGENT_PII_ENTITY_PYTHON?.trim();
  const modelPath = env.CODE_AGENT_GLINER_PII_MODEL?.trim();
  const enabled = provider === 'gliner-onnx-command' || provider === 'command';
  const defaultTimeoutMs = provider === 'gliner-onnx-command' ? 15_000 : 1_500;

  return {
    enabled,
    provider,
    labels: parseList(env.CODE_AGENT_PII_ENTITY_LABELS, DEFAULT_LABELS),
    threshold: parseNumber(env.CODE_AGENT_PII_ENTITY_THRESHOLD, 0.5),
    timeoutMs: Math.max(100, parseNumber(env.CODE_AGENT_PII_ENTITY_TIMEOUT_MS, defaultTimeoutMs)),
    maxChars: Math.max(1_000, parseNumber(env.CODE_AGENT_PII_ENTITY_MAX_CHARS, 8_000)),
    command,
    pythonPath,
    modelPath,
  };
}

export function getConfiguredPiiEntityDetector(
  config = getPiiEntityDetectorConfig(),
): PiiEntityDetector | null {
  if (detectorOverride !== undefined) return detectorOverride;
  if (!config.enabled) return null;
  if (configuredDetector) return configuredDetector;

  if (!config.command) {
    logger.debug('PII entity detector enabled without command; falling back to deterministic guard');
    return null;
  }

  configuredDetector = new CommandPiiEntityDetector(config.command, config.timeoutMs, config.pythonPath);
  return configuredDetector;
}

export function setPiiEntityDetectorForTesting(detector: PiiEntityDetector | null | undefined): void {
  detectorOverride = detector;
  configuredDetector = undefined;
}

class CommandPiiEntityDetector implements PiiEntityDetector {
  readonly id = 'gliner-onnx-command';

  constructor(
    private readonly command: string,
    private readonly timeoutMs: number,
    private readonly pythonPath?: string,
  ) {}

  async detect(request: PiiEntityDetectionRequest): Promise<PiiEntity[]> {
    const stdout = await runCommandDetector(this.command, request, this.timeoutMs, this.pythonPath);
    const parsed = JSON.parse(stdout) as { entities?: PiiEntity[] };
    return Array.isArray(parsed.entities) ? parsed.entities : [];
  }
}

function runCommandDetector(
  command: string,
  request: PiiEntityDetectionRequest,
  timeoutMs: number,
  pythonPath?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath || command, pythonPath ? [command] : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PII entity detector timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString('utf8') || `PII entity detector exited with ${code}`));
    });

    child.stdin.end(JSON.stringify(request));
  });
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  const parsed = value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed?.length ? parsed : fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeEntityLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'entity';
}

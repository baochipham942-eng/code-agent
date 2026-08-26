#!/usr/bin/env node

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

function usage() {
  return 'Usage: node scripts/verify-shot.mjs <url> <out.png> [--viewport 1440x900] [--wait selector]';
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function parseViewport(value = '1440x900') {
  const match = value.match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) throw new Error(`invalid viewport: ${value}`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 240 || width > 7680 || height > 4320) {
    throw new Error(`viewport is outside 320x240..7680x4320: ${value}`);
  }
  return { width, height };
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }
  const [rawUrl, rawOutput] = args;
  if (!rawUrl || !rawOutput || rawUrl.startsWith('--') || rawOutput.startsWith('--')) {
    throw new Error(usage());
  }
  const url = new URL(rawUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('verify-shot only accepts local http(s) URLs');
  }
  const viewport = parseViewport(optionValue(args, '--viewport'));
  const waitSelector = optionValue(args, '--wait');
  const knownArgs = new Set([rawUrl, rawOutput, '--viewport', optionValue(args, '--viewport'), '--wait', waitSelector].filter(Boolean));
  const unknown = args.find((arg) => !knownArgs.has(arg));
  if (unknown) throw new Error(`unknown option: ${unknown}`);

  const output = path.resolve(rawOutput);
  mkdirSync(path.dirname(output), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (waitSelector) {
      await page.waitForSelector(waitSelector, { state: 'visible', timeout: 60_000 });
    } else {
      await page.waitForSelector('body', { state: 'visible', timeout: 60_000 });
    }
    await page.screenshot({ path: output });
    console.log(`NEO_VERIFY_SHOT=${output}`);
  } finally {
    await browser.close();
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(`verify-shot: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

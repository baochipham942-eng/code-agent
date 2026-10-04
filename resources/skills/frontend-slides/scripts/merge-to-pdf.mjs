// Runs the self-contained bundle so pdf-lib resolves without the repo node_modules.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundlePath = join(dirname(fileURLToPath(import.meta.url)), 'merge-to-pdf.bundle.mjs');
await import(pathToFileURL(bundlePath).href);

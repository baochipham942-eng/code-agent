// Runs the self-contained bundle so pptxgenjs resolves without the repo node_modules.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bundlePath = join(dirname(fileURLToPath(import.meta.url)), 'merge-to-pptx-hybrid.bundle.mjs');
await import(pathToFileURL(bundlePath).href);

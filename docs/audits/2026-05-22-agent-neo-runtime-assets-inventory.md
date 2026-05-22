# Runtime Assets Inventory

Generated: 2026-05-22T03:30:23.259Z

Root: `/Users/linchen/Downloads/ai/code-agent/src-tauri/target/release/bundle/macos/Agent Neo.app/Contents/Resources/_up_`

## Summary

- Total size: 29.2 MiB
- Files: 226
- Groups: 11

| Placement | Size | Groups | Files |
| --- | --- | --- | --- |
| bundle-core | 27.0 MiB | 7 | 194 |
| managed-candidate | 1.87 MiB | 1 | 29 |
| optional-candidate | 304.5 KiB | 3 | 3 |

## Top Level

| Path | Size | Files |
| --- | --- | --- |
| `dist` | 26.2 MiB | 126 |
| `node_modules` | 2.65 MiB | 90 |
| `scripts` | 304.5 KiB | 3 |
| `resources` | 12.3 KiB | 6 |
| `package.json` | 11.5 KiB | 1 |

## Managed Runtime Candidates

| Group | Size | Priority | Rationale |
| --- | --- | --- | --- |
| `dist/native` | 1.87 MiB | P1 review | Native runtime assets can move later, but need code-path and signing verification first. |
| `scripts/vision-tagger` | 115.7 KiB | P1 candidate | Signed helper executable; can move only with helper signing, hash verification, and fallback. |
| `scripts/vision-ocr` | 94.8 KiB | P1 candidate | Signed helper executable; can move only with helper signing, hash verification, and fallback. |
| `scripts/system-audio-capture` | 94.0 KiB | P1 candidate | Signed helper executable; can move only with helper signing, hash verification, and fallback. |

## Review Later

No large unclassified groups.

## Keep In App Shell

| Group | Size | Reason |
| --- | --- | --- |
| `dist/web` | 14.7 MiB | App UI/server runtime; changes frequently and stays tied to the signed app shell. |
| `dist/renderer` | 9.66 MiB | App UI/server runtime; changes frequently and stays tied to the signed app shell. |
| `node_modules/better-sqlite3` | 1.85 MiB | Core local data, credential, or terminal runtime; moving it raises startup and support risk. |
| `node_modules/keytar` | 518.4 KiB | Core local data, credential, or terminal runtime; moving it raises startup and support risk. |
| `node_modules/node-pty` | 299.6 KiB | Core local data, credential, or terminal runtime; moving it raises startup and support risk. |
| `resources/browser-relay-extension` | 12.3 KiB | Small item; splitting it out is unlikely to pay for its complexity. |
| `package.json` | 11.5 KiB | Runtime package metadata used by bundled Node code. |

## Largest Files

| File | Size | SHA-256 |
| --- | --- | --- |
| `dist/web/webServer.cjs` | 14.7 MiB | `0825e1515e11...` |
| `dist/renderer/assets/index-v-JVkFYk.js` | 2.78 MiB | `f74652570ded...` |
| `dist/renderer/assets/vendor-mermaid-DG2yKT8Z.js` | 2.67 MiB | `9e9818253533...` |
| `dist/native/better-sqlite3/build/Release/better_sqlite3.node` | 1.83 MiB | `1e34a5822c23...` |
| `node_modules/better-sqlite3/build/Release/better_sqlite3.node` | 1.83 MiB | `1e34a5822c23...` |
| `dist/renderer/pdf.worker.min.mjs` | 1.02 MiB | `e833e0e7445b...` |
| `dist/renderer/assets/CodeEditor-BhDzVSOQ.js` | 609.9 KiB | `cd204c8e2f8f...` |
| `dist/renderer/assets/vendor-charts-BR6Ykyn3.js` | 433.8 KiB | `99a6a5434e87...` |
| `dist/renderer/assets/vendor-katex-MHmgQ4CW.js` | 292.8 KiB | `691040c1d5e1...` |
| `dist/renderer/assets/index-CrETUIHN.css` | 202.8 KiB | `53eabeca92fc...` |
| `node_modules/keytar/node_modules/node-addon-api/napi-inl.h` | 199.7 KiB | `141fee09a543...` |
| `dist/renderer/assets/html2canvas-D2IFRHxX.js` | 194.9 KiB | `953c3e6eb625...` |
| `dist/renderer/assets/vendor-markdown-BAd2ID_x.js` | 130.1 KiB | `f386ade1af6e...` |
| `dist/renderer/assets/vendor-reactflow-CAA5mF3K.js` | 122.1 KiB | `fb60daf07eaa...` |
| `node_modules/keytar/node_modules/node-addon-api/napi.h` | 118.2 KiB | `38ece42f702d...` |

## P0 Recommendation

Continue the managed runtime path instead of a binary patch updater:

1. Keep the Tauri app shell on the existing signed full-package updater path.
2. Move each large candidate only after resolver, fallback, hash verification, and rollback behavior are proven.
3. Keep native helpers and database/credential/terminal modules in the signed app until signing and rollback behavior is proven.
4. Re-run this inventory after each release bundle to measure actual size movement.

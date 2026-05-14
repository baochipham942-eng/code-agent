# Sensitive Data Guard

## Scope

Scope 1 is the local derived-data desensitization layer. It protects copies that are injected into prompts, persisted as derived memory or knowledge, written to diagnostic stores, summarized by a model, or shared through exports.

Raw session messages remain full fidelity in this slice. They are the operational source of truth for replay, fork, search, and editing workflows. The guard applies to sinks and derived views around that source.

## Current Data Flow

| Surface | Main flow | Guarded in this slice |
| --- | --- | --- |
| prompt | system prompt assembly, activity context, memory snippets, system prompt cache | memory prompt snippets, activity prompt formatting, system prompt cache |
| memory | file memory tools, compaction flush, session learning extraction, SQLite memory repository | file write/read content, injected memory content, generated preservation summaries, repository create/update |
| activity | OpenChronicle, native desktop, audio, screenshot analysis, renderer/provider activity context | provider text, item fields, evidence refs, raw event removal, prompt formatter, native desktop snapshot, screenshot pixel redaction |
| channel | feishu / telegram / http-api inbound messages, raw event storage | inbound message text/sender/attachments, raw payload, gated by per-channel privacy mode |
| knowledge | browser/manual/local capture, capture DB, vector store | capture title/url/content/summary/tags/metadata before DB and vectorization |
| transcript | local transcript exporter, optional AI summary | anonymization path uses shared guard, summary prompt input is guarded |
| export | markdown/session export, tool details | Browser/Computer redaction remains, shared guard now runs on tool details and final markdown |
| telemetry | turns, model calls, tool calls, events, system prompt cache | prompts, completions, tool args/results, events, session title/path |

## Policy

The shared entrypoint is `src/main/security/sensitiveDataGuard.ts`.

It handles:

- provider secrets through the existing `SensitiveDetector`
- email, IP, and home directory masking through `LogMasker`
- URL credential/query/hash removal
- sensitive object keys such as password, token, authorization, cookie, secret, and api key
- prompt-injection neutralization for model-context surfaces
- screenshot/audio evidence filename hiding for activity context
- deterministic PII such as US SSN and Luhn-valid credit card numbers (`redactDeterministicPii`)

Browser/Computer redaction stays as a specialized adapter because it knows action semantics such as typed input, form data, cookies, DOM snapshots, and profile paths. Sensitive Data Guard complements it for general local data.

## Channel and Local Activity Privacy Firewall (2026-05-14)

Two firewall layers wrap the shared guard so that inbound channel messages and local desktop activity are sanitized before they land in storage or fan out to an agent run.

### Channel privacy firewall

`src/main/channels/privacy/channelPrivacyFirewall.ts` sanitizes channel messages, attachments and raw payloads through `guardSensitiveText`. It exposes a per-channel `ChannelPrivacyMode`:

| Mode | Behavior |
| --- | --- |
| `local-redact` | Default. Inbound text, attachments and raw payload are redacted before local persistence or dispatch. |
| `allow-raw` | Business text is still redacted, but the original raw payload is retained for connector debugging. |
| `off` | Channel-layer redaction disabled, length-trim only — controlled local debugging use. |

`feishuPrivacy.ts` is the thin Feishu binding (`sanitizeFeishuInboundMessage` / `sanitizeFeishuRawEventForStorage`); `FeishuChannel` resolves the mode at init and sanitizes every inbound message at construction. The mode is configurable per channel in `ChannelsSettings`. `ChannelPrivacyConfig` is mixed into `HttpApiChannelConfig` / `FeishuChannelConfig` / `TelegramChannelConfig`.

### Local activity privacy firewall

`src/main/services/activity/localActivityPrivacyFirewall.ts` sanitizes `DesktopActivityEvent` fields (appName, windowTitle, browserUrl, documentPath, analyzeText, etc.) on the `local-persist` mode. `NativeDesktopService.parseEventLine` runs it on every collected event line, and `desktopVisionAnalyzer` sanitizes vision analyze-text before it is written back to SQLite.

`screenshotPrivacyRedactor.ts` adds pixel-level redaction: it extracts explicit / OCR redaction regions from event metadata (multi-format bbox parsing, normalized-coordinate detection), blurs them with `sharp`, and falls back to full-frame blur when analyze-text is sensitive but no regions are available.

### Rust-side symmetry

`src-tauri/src/native_desktop.rs` mirrors the deterministic redaction at the collector boundary: `sanitize_snapshot_for_local_persistence` strips home paths, emails and Luhn-valid credit card numbers, and `sanitize_browser_url_for_local_activity` removes URL credentials, query and fragment before the snapshot is persisted. This keeps the Rust collector and the TypeScript guard on the same redaction contract.

## Optional GLiNER PII Entity Layer

Model-based PII detection is an opt-in enhancer, not the default path.

The shared async entrypoint is `guardSensitiveTextAsync()`. It first runs the deterministic guard, then optionally calls the configured PII entity detector for natural-language segments. Fenced code blocks are skipped to reduce false positives in source code and JSON examples.

Current provider contract:

- `CODE_AGENT_PII_ENTITY_DETECTOR=gliner-onnx-command`
- `CODE_AGENT_GLINER_PII_COMMAND=/absolute/path/to/local-runner`
- `CODE_AGENT_GLINER_PII_RUNNER_PYTHON=/absolute/path/to/gliner-venv/bin/python`
- `CODE_AGENT_GLINER_PII_MODEL=/absolute/path/to/gliner-pii-base-onnx`
- optional `CODE_AGENT_PII_ENTITY_LABELS=person,organization,address,phone number,...`
- optional `CODE_AGENT_PII_ENTITY_THRESHOLD=0.5`
- optional `CODE_AGENT_PII_ENTITY_TIMEOUT_MS=30000` for cold GLiNER ONNX starts

The command runner receives JSON on stdin:

```json
{
  "text": "Alice Zhang lives in Shanghai.",
  "labels": ["person", "location"],
  "threshold": 0.5,
  "modelPath": "/models/gliner-pii-base-onnx",
  "surface": "export",
  "mode": "share"
}
```

It must write JSON on stdout:

```json
{
  "entities": [
    { "start": 0, "end": 11, "label": "person", "score": 0.91 }
  ]
}
```

If the command is missing, exits non-zero, times out, or returns invalid output, the guard falls back to deterministic redaction and does not block the user flow.

## Non-Goals In Scope 1

- Redacting raw session message storage.
- Rewriting retrieval keys such as `projectPath`, where exact matching is still used by memory lookup.
- A policy UI or per-field user configuration.
- Retrofitting historical database rows.
- Bundling GLiNER weights or making ONNX runtime a startup dependency.

## Expected Use

New local sinks should call:

- `guardSensitiveText(value, { surface, mode })` for text.
- `guardSensitiveTextAsync(value, { surface, mode })` when the caller can use optional model-based PII detection.
- `guardSensitiveValue(value, { surface, mode })` for structured data.
- `guardSensitiveJsonText(value, { surface, mode })` for JSON telemetry strings that should remain parseable.

Use `mode: 'model-context'` for anything sent to a model. Use `mode: 'share'` for exports. Use `mode: 'local-persist'` for derived memory/knowledge storage. Use `mode: 'diagnostic'` for telemetry and caches.

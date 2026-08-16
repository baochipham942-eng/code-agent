# Neo voice regression eval

Manual, paid regression gate for the realtime voice line. It reuses the validated N-L7 PCM fixtures and protocol flow while deriving `instructions`, tool definitions, provider profile, and `session.update` from production source on every run.

```bash
npm run voice-eval
npm run voice-eval -- --scenario reception_fragmentation
npm run voice-eval -- --scenario interrupt_classification,approval_notice
npm run voice-eval -- --dry-run
npm run voice-eval -- --replay tests/voice-eval/reports/<run>.jsonl
```

The full suite estimates cost before reading the API key and is hard-capped at 50 short sessions. The current full plan uses 21: one connectivity/tool echo call plus ten ABAB production/mutation pairs. Terminal dispatch and SAY_GAP reuse the production arm instead of paying for duplicate calls.

This suite is manual by design and must not be added to default CI. Raw per-call JSONL and JSON/Markdown reports are written to `reports/`. `baselines/2026-08-16.json` is the first accepted live baseline.

Gates:

- connectivity/tool echo: upstream `session.updated` echoes the exact production tool table and a complete task produces `delegate_task`;
- reception: the production arm holds all 10 half utterances; deleting the production reception rule must make the same gate fail;
- terminal dispatch: at least 9/10 completed fragmented requests dispatch;
- SAY_GAP: preserve the native upstream gap count, then require the production Host semantic-guard event chain to reduce final SAY_GAP to 0/10;
- interruption: production decision code keeps television speech and accepts addressed human barge-in;
- approval: the real coordinator event-chain test proves a permission event produces one worth-hearing notice with an explicit allow/deny exit.

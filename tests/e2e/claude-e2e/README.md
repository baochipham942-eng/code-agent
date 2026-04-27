# Claude E2E Legacy Harness

This directory is a legacy manual Claude/code-agent CLI benchmark harness. It is
kept out of the root package scripts, root Vitest suite, and product IPC eval
flow.

Current product evaluation data should flow through the canonical eval run
contract in `src/shared/contract/evaluation.ts` and be persisted by
`src/main/evaluation/experimentAdapter.ts`.

Use this harness only for historical comparison or by importing its results
through an adapter into the canonical contract.

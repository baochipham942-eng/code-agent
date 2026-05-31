# Artifact Verifiers Acceptance

## Scope

This acceptance note covers the current artifact verification family:

- Game verifier and subtype checkers
- DeckVerifier
- DashboardVerifier / interactive app probes
- Repair guard and runtime evidence checks

## Commands

Deck live acceptance:

```bash
npx tsx scripts/acceptance/deck-generation.ts --live
```

Browser / dashboard visual smoke dependencies are shared with the Browser / Computer suite:

```bash
npm run acceptance:browser-computer-all
```

Game verifier regression tests live under the runtime and unit test suites; run the targeted test names used by the current branch when changing game subtype logic or repair guards.

## Pass Criteria

| Area | Criteria |
|------|----------|
| Game | subtype registry picks the intended checker; non-matching subtypes do not receive platformer-specific repair guidance; repair stays within scope guard and respects repair cap |
| Deck | schemaProbe passes structured slide shape; narrative probes catch missing title/conclusion/story issues; `pptGenerate` uses DeckVerifier instead of dead `validateNarrative` paths |
| Dashboard | HTML probes can detect missing structure; browser visual smoke runs a real page; interaction probes prove visible controls create state change |
| Runtime evidence | verifier failures include concrete file, browser smoke, or contract evidence that can guide repair |

## Safety Boundary

Verifier failures should guide repair, not silently rewrite unrelated files. Repair prompts must keep scope narrow, and browser smoke should use local or generated artifacts rather than uncontrolled external sites.

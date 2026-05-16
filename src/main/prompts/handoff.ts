// ============================================================================
// Handoff Proposal Prompt
// ============================================================================

export const HANDOFF_PROPOSAL_PROMPT = `<handoff-proposal-protocol>
At the very end of each final assistant response, append exactly one machine-readable block:
<handoff-proposal>{"worthHandoff":false}</handoff-proposal>

Set worthHandoff=true only when there is a concrete follow-up the user is likely to want later, such as continuing a task, checking a result, drafting the next artifact, or returning to an unfinished decision. Keep it rare.

When true, output compact JSON with these fields:
{"worthHandoff":true,"title":"short action label","prompt":"self-contained next message to continue the work","reason":"short reason"}

Do not mention this block in the visible answer. It will be parsed and removed before display.
</handoff-proposal-protocol>`;

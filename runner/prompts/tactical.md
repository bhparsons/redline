# Redline tactical edit

You are making one small, fast edit to one block of an HTML document under review. Reply with ONLY a single JSON object — no prose, no markdown fences.

- Run id: {{RUN_ID}}

## Reviewer comment

{{COMMENT}}

## The block

The ONLY block you may edit, data-rev id `{{BLOCK_ID}}`. Its current inner HTML:

{{BLOCK_HTML}}

## Editing rules (distilled)

{{SKILLS}}

## Your reply

Either make the edit:

{
  "runId": "{{RUN_ID}}",
  "decisions": [
    {
      "id": "<the comment id above>",
      "decision": "addressed" | "declined" | "deferred",
      "summary": "<one line>",
      "note": "<optional>"
    }
  ],
  "blockEdits": [
    { "id": "{{BLOCK_ID}}", "newInner": "<the FULL replacement inner HTML>" }
  ]
}

Or, if this comment needs more than a single-block edit (document-wide context, outside research, ambiguity you cannot resolve from the block alone), escalate instead:

{ "escalate": true }

Rules:

- Exactly ONE decision, whose `"id"` is exactly the comment id above.
- `"blockEdits"` may only target `{{BLOCK_ID}}`, at most once; `[]` is valid when declining or deferring.
- `"newInner"` replaces the block's whole inner HTML. Never alter, remove, or invent `data-rev` attributes. Escape a literal `<`, `>` or `&` in text as an entity, and emit balanced markup.
- When in doubt, escalate — a wrong small edit is worse than a slower right one.

# Observability — run timing, token usage, and traces

Every revise run records what happened, regardless of configuration:

- **Per-phase timing** on the sidecar run record (`runs[].phases[]`): one entry
  per agent spawn (`planner`, `executor` / `executor-N`) with `startedAt`,
  `durationMs`, `exitCode`, the effective `model`, and `promptChars` (the size
  of the exact prompt redline sent).
- **Token usage** per executor phase (claude preset only — parsed from the
  stream-json log): `usage: {inputTokens, outputTokens, cacheReadTokens,
  cacheCreationTokens, costUsd?, turns?}`. The delta between `promptChars` and
  billed `inputTokens` is the over/under-loading diagnostic: it isolates what
  the agent CLI loaded beyond what redline sent (its own project conventions
  file, its system prompt).
- **The rendered prompt itself**, persisted per phase next to the run log:
  `<gitRoot>/tmp/review-runs/<runId>[.planner|.groupN].prompt.md` — byte-level
  ground truth for "what did redline send". Local diagnostics only; never
  committed (run commits are pathspec-scoped to doc + sidecar).

## Trace export (optional, default OFF)

Add to `review.config.json`:

```json
{
  "telemetry": {
    "endpoint": "http://127.0.0.1:6006",
    "headers": { "authorization": "Bearer …" }
  }
}
```

On every run finish or failure, the server POSTs one OTLP/HTTP (JSON) trace to
`<endpoint>/v1/traces`: a root `revise-run` span (run id, page, agent, status,
error, sent count, capabilities, commit) with one child span per phase carrying
OpenInference attributes (`llm.model_name`, `llm.token_count.prompt`,
`llm.token_count.completion`, cache reads, cost, turns) so LLM-aware backends
render proper model/token panes. Export is fire-and-forget: a dead or slow
backend never delays or fails a run. `headers` is optional — that's where a
hosted backend's API key goes.

The exporter is backend-neutral (plain OTLP): Phoenix, Arize, Langfuse,
Honeycomb, Jaeger — switching is a config change, no code.

## Quick start: Arize Phoenix (free, local)

Traces embed run metadata and prompt sizes — and your future backend choice may
add prompt contents — so the recommended default keeps everything on-machine:

```bash
docker run -p 6006:6006 arizephoenix/phoenix:latest
# or: pip install arize-phoenix && phoenix serve
```

Then set `"telemetry": {"endpoint": "http://127.0.0.1:6006"}` in
`review.config.json`, restart the review server, and run a revise. Open
http://localhost:6006 — each run appears as a trace; phase spans show model,
duration, and token counts.

Upgrading to Arize (hosted) later — or any other OTLP backend — is the same
two config lines pointed elsewhere.

## Reading the numbers

- **Slow run?** Look at which phase owns the wall clock. A 2-minute `planner`
  span on a 3-comment run is routing overhead, not editing work.
- **Context bloat?** Compare `promptChars` (what redline sent) against
  `inputTokens` minus `cacheReadTokens` (what was billed fresh). A large gap is
  implicit context the CLI loaded; a large `promptChars` is redline's own
  prompt to trim.
- **Cheap vs expensive tiers:** `costUsd` per phase makes the planner-routing
  tier map (`modelTiers`) auditable against real spend.

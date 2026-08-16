// runner/config/defaults.mjs — model-tier defaults (frontload decision 3).
//
// Three tiers, overridable per-key in redline.config.json `modelTiers`.
// These are starting defaults; the eval harness (WP5) measures them and may
// recommend changes, which the user approves at the end of the milestone.

export const TIERS = Object.freeze(['simple', 'standard', 'complex']);

// DECISION (2026-07-24, Blake): `complex` drops opus-4-8 for sonnet-5. The
// 22-fixture live eval scored complex/opus at 92.3% — the WORST of the three
// tiers — at $1.08 against standard's $0.24 and simple's $0.02, and its two
// recorded failures were capability failures (declined to verify without web
// access; one malformed decision), not context failures a bigger model fixes.
// So the ladder now has two distinct models, not three. The `complex` LABEL is
// still routed and recorded per comment, so the eval harness (#49) can still
// ask "would a larger model have helped here?" and re-pointing this key is a
// one-line, evidence-backed flip.
export const DEFAULT_MODEL_TIERS = Object.freeze({
  simple: 'google/gemini-2.5-flash',
  standard: 'anthropic/claude-sonnet-5',
  complex: 'anthropic/claude-sonnet-5',
});

// Per-MODEL reasoning budget, sent as OpenRouter's top-level `reasoning`
// object (#83 part 2). Keyed by model rather than by tier on purpose: the
// legal SHAPE is a property of the provider, not of our ladder — Anthropic
// takes `effort` (its `reasoning.max_tokens` is accepted and ignored), Gemini
// 2.5 takes a `max_tokens` thinking budget and exposes no effort levels at all.
// A tier map would have had to carry provider-specific shapes anyway, and
// `standard` and `complex` resolve to the same model today.
//
// A model with no entry sends NO reasoning field, which is today's behavior —
// so an author who pins `models.<archetype>` to something else is unaffected.
//
// WHY ONLY SONNET HAS AN ENTRY. `design/cost-model.md` measured reasoning at
// "86-424 [tokens] per run on sonnet, 0 on flash": the simple tier already
// emits no reasoning tokens, so there is nothing there to lower, and because
// OpenRouter infers `enabled` from `effort`/`max_tokens`, sending flash a
// reasoning object would TURN THINKING ON and raise the cheapest lane's bill.
// The floor for the simple tier is to send nothing.
//
// WHY `low` ON SONNET. OpenRouter reports sonnet-5's `default_effort` as
// `high`, so every standard/complex run has been paying for high-effort
// thinking we never asked for. The in-repo evidence says this task does not
// need it: the M1 22-fixture eval scored flash — which does no reasoning at
// all — at 94.5% against sonnet's 94.1% (design/m1/M1-REPORT.md). `low` is the
// floor short of disabling reasoning outright on that model.
//
// UNMEASURED: this is a quality lever with no eval behind it. #49's harness is
// where a regression would show up; re-measure there before lowering further.
export const DEFAULT_MODEL_REASONING = Object.freeze({
  'anthropic/claude-sonnet-5': Object.freeze({ effort: 'low' }),
});

// Archetype → tier, used when the router falls back to the keyword classifier
// (router.fallbackRoute) and as the reference ladder the eval harness reports
// against. The router's own LLM call may pick a different tier per comment;
// this is the floor, not a cap.
//
// DECISION (2026-07-22, post-M1; see design/m1/M1-REPORT.md "Eval results"):
// the live 22-fixture eval put the simple tier at 94.5% aggregate quality vs.
// 94.1% for standard, at ~29x lower cost and ~3.5x lower latency, and it hit
// 87.5% of standard on `tactical` and 96% on `content` — both above the 80%
// bar set in frontload decision 7. So `tactical` and `content` now default to
// `simple`. `redesign` stays `standard` (simple scored .96 there, but the
// standard-tier miss was a judgment call on page-wide scope, so the safer
// default holds until a larger fixture set says otherwise) and `research`
// moves to `complex` (research asks reason across the document and are the
// ones most likely to need real capability, not speed). `accessibility` stays
// `standard`. Revisit when the fixture set grows past 22.
export const DEFAULT_ARCHETYPE_TIERS = Object.freeze({
  tactical: 'simple',
  redesign: 'standard',
  research: 'complex',
  accessibility: 'standard',
  content: 'simple',
});

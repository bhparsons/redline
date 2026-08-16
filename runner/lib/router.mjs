// runner/lib/router.mjs — the small-model comment router (WP3).
//
// routeComment() replaces bare classify() in the run path: one cheap, fast
// LLM call (the simple-tier model, small prompt, low token cap) that returns
//   { archetype, scope, tier, canTactical, skills, source: 'router' }
// where tier picks the revise model from config.modelTiers and skills names
// the lib/skills.mjs files worth inlining (null = no narrowing).
//
// FAIL-SAFE: any problem — transport error, timeout, bad JSON, bad shape —
// falls back to the keyword classifier with the pre-WP3 behavior exactly
// (archetype model from config.models, no skill narrowing), marked
// source: 'fallback'. Routing can never fail a run.
//
// Model resolution (modelForRoute): an author who pinned models.<archetype>
// in redline.config.json keeps that model even when the router runs; only
// unpinned archetypes flow through the tier ladder.

import { promises as fs } from 'node:fs';
import { classify, ARCHETYPES } from './classify.mjs';
import { completeChat, stripFences } from './agent.mjs';
import { listSkills } from './skills.mjs';
import { TIERS, DEFAULT_ARCHETYPE_TIERS } from '../config/defaults.mjs';

export const SCOPES = Object.freeze(['block', 'section', 'document']);
export const ROUTER_TIMEOUT_MS = 15_000;
export const ROUTER_MAX_TOKENS = 300;

// Keyword-classifier tier mapping for the fallback path. Lives in
// runner/config/defaults.mjs — see the tier-default decision recorded there.
export const FALLBACK_TIERS = DEFAULT_ARCHETYPE_TIERS;

const PROMPT_URL = new URL('../prompts/router.md', import.meta.url);
let promptCache = null;

async function loadPrompt() {
  if (promptCache === null) promptCache = await fs.readFile(PROMPT_URL, 'utf8');
  return promptCache;
}

// The pre-WP3 behavior as a route object (frontload decision 4 gives the
// tactical-eligible archetypes for canTactical).
export function fallbackRoute(commentBody) {
  const archetype = classify(commentBody);
  return {
    archetype,
    scope: 'block',
    tier: FALLBACK_TIERS[archetype],
    canTactical: archetype === 'tactical' || archetype === 'content',
    skills: null,
    source: 'fallback',
  };
}

// Validate + normalize the router's JSON. Returns a route or null. Unknown
// skill names are dropped (not fatal — the model may hallucinate one).
export function validateRoute(value, knownSkillNames) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!ARCHETYPES.includes(value.archetype)) return null;
  if (!SCOPES.includes(value.scope)) return null;
  if (!TIERS.includes(value.tier)) return null;
  if (typeof value.canTactical !== 'boolean') return null;
  if (!Array.isArray(value.skills) || value.skills.some((s) => typeof s !== 'string')) return null;
  return {
    archetype: value.archetype,
    scope: value.scope,
    tier: value.tier,
    canTactical: value.canTactical,
    skills: value.skills.filter((s) => knownSkillNames.includes(s)),
    source: 'router',
  };
}

// The revise model for a route: author-pinned archetype model first, then
// the tier ladder; the fallback path keeps config.models wholesale.
export function modelForRoute(route, config) {
  if (route.source === 'fallback') return config.models[route.archetype];
  return config.modelOverrides?.[route.archetype] ?? config.modelTiers[route.tier];
}

// Route one comment. Never throws, never fails the run.
//
// `capture` (optional) is the same hook completeChat fills in — .request,
// .httpStatus, .envelope, .content — plus `.usage`, the billed usage of the
// classification call. Every comment makes this call, and until #124 its cost
// (~$0.00024) was recorded nowhere: noise on a sonnet standard run, 38% of a
// gemini-flash tactical one. The capture is filled in whenever the call
// COMPLETED, fallback paths included — a reply we could not parse was still
// charged for.
export async function routeComment({ comment, blockInner = '', config, log = console.warn, capture = null }) {
  try {
    const skills = await listSkills({ config, log });
    const skillLines = skills
      .filter((s) => !(s.origin === 'packaged' && (s.name === 'default' || ARCHETYPES.includes(s.name))))
      .map((s) => `- ${s.name} (${s.origin}): ${s.body.split('\n')[0].slice(0, 120)}`);
    const template = await loadPrompt();
    const prompt = template
      .split('{{COMMENT}}').join(comment.body)
      .split('{{BLOCK_CHARS}}').join(String(blockInner.length))
      .split('{{BLOCK_HTML}}').join(blockInner.slice(0, 4096))
      .split('{{SKILLS}}').join(skillLines.length > 0 ? skillLines.join('\n') : '(none beyond the built-in editing rules)');

    const res = await completeChat({
      prompt,
      model: config.modelTiers.simple,
      config,
      capture,
      temperature: 0,
      maxTokens: ROUTER_MAX_TOKENS,
      timeoutMs: Math.min(ROUTER_TIMEOUT_MS, config.agent.timeoutMs ?? ROUTER_TIMEOUT_MS),
    });
    // Set BEFORE the shape checks below: an unparseable reply was still billed.
    if (capture !== null && res.usage) capture.usage = res.usage;
    if (!res.ok) return fallbackRoute(comment.body);

    let parsed;
    try {
      parsed = JSON.parse(stripFences(res.content));
    } catch {
      return fallbackRoute(comment.body);
    }
    const route = validateRoute(parsed, skills.map((s) => s.name));
    return route ?? fallbackRoute(comment.body);
  } catch {
    return fallbackRoute(comment.body);
  }
}

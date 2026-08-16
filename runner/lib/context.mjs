// runner/lib/context.mjs — context assembly for the revise prompt.
//
// Since WP0 this is a thin compatibility wrapper over the skill system
// (lib/skills.mjs): the bundled packs moved from runner/context/ to
// runner/skills/ and became packaged skills, joined by user skills
// (~/.redline/skills/) and project skills (config `skills` +
// `projectContext`). Selection semantics are unchanged for the packs:
//   1. default.md — ALWAYS included.
//   2. <archetype>.md — included when the pack exists. tactical has no pack
//      on purpose (small fixes need no extra rules).
//   3. config projectContext / skills files — author-supplied, guarded by
//      the same traversal/dotfile rules as file serving; anything rejected
//      or missing is skipped and logged, never a failed run.
//
// loadContext(archetype, config) keeps its signature for existing callers
// and tests; api.mjs may call loadSkills directly to pass the comment text
// (keyword-matched skills) or a router's skill selection.

import { loadSkills } from './skills.mjs';

// Assemble the context text for one run. Returns a string (never throws for
// a bad projectContext entry — those are skipped and logged via `log`).
export async function loadContext(archetype, config, { log = console.warn, comment = '' } = {}) {
  const { text } = await loadSkills({ comment, archetype, config, log });
  return text;
}

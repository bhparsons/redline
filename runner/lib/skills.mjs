// runner/lib/skills.mjs — the skill system: packaged, user, and project skills.
//
// A skill is a Markdown file loaded into prompts verbatim. Three origins,
// assembled in this order (frontload decision 6):
//   packaged  runner/skills/*.md — ship with Redline. default.md ALWAYS
//             applies; an archetype-named file (redesign.md, …) applies to
//             its lane only (tactical has no pack on purpose); any other
//             packaged file follows its metadata header.
//   user      *.md under ~/.redline/skills/ (or REDLINE_SKILLS_DIR).
//   project   paths in redline.config.json under `skills` (plus the older
//             `projectContext` files, kept always-relevant), relative to the
//             served root, through the SAME traversal/dotfile guard as file
//             serving — anything rejected or missing is skipped and logged,
//             never a failed run.
//
// Relevance metadata rides in an optional HTML comment header at the top of
// the file:
//   <!-- redline-skill
//   archetypes: content, redesign
//   keywords: tone, voice
//   -->
// No header → the skill applies to every run. With a header, the skill
// applies when its archetypes list names the run's archetype OR any keyword
// appears (case-insensitive) in the comment text.
//
// Distillation (the tactical lane's small-context form, frontload decision
// 5): a skill may mark its distilled form with a `<!-- distill-end -->` line
// — everything above the marker (header excluded) is the distilled text.
// Without a marker, the text is truncated at the last paragraph boundary
// inside DISTILL_MAX_CHARS. Distillation never invents content.
//
// No skill can override the core editing invariants: skills are prompt text
// only — the runner still validates every write through surgery.mjs.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePath } from './paths.mjs';
import { ARCHETYPES } from './classify.mjs';

export const PACKAGED_SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));
export const DISTILL_MAX_CHARS = 800;
const DISTILL_MARKER = /^[ \t]*<!--\s*distill-end\s*-->[ \t]*$/m;
const HEADER_RE = /^\s*<!--\s*redline-skill\b([\s\S]*?)-->\s*\n?/;

// Default user-skills directory, overridable for tests and portable setups.
export function userSkillsDir(env = process.env) {
  if (typeof env.REDLINE_SKILLS_DIR === 'string' && env.REDLINE_SKILLS_DIR.length > 0) {
    return env.REDLINE_SKILLS_DIR;
  }
  return path.join(os.homedir(), '.redline', 'skills');
}

const splitList = (value) => value.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);

// Parse one skill file into {name, origin, meta, body}. The metadata header
// (when present) is stripped from the body — it is loader plumbing, not
// prompt content.
export function parseSkill(name, origin, raw) {
  const meta = { archetypes: [], keywords: [] };
  let body = raw;
  const m = HEADER_RE.exec(raw);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = /^\s*(archetypes|keywords)\s*:\s*(.+)$/.exec(line);
      if (kv) meta[kv[1]] = splitList(kv[2]);
    }
  }
  return { name, origin, meta, body: body.trim(), hasHeader: m !== null };
}

// Does this skill apply to the run at hand? Packaged archetype packs are
// pinned by NAME (default always, <archetype>.md to its lane); everything
// else follows the metadata header, and no header means always.
export function skillApplies(skill, { archetype, comment = '' } = {}) {
  if (skill.origin === 'packaged') {
    if (skill.name === 'default') return true;
    if (ARCHETYPES.includes(skill.name)) return skill.name === archetype;
  }
  if (!skill.hasHeader) return true;
  if (skill.meta.archetypes.includes(String(archetype).toLowerCase())) return true;
  const haystack = String(comment).toLowerCase();
  return skill.meta.keywords.some((kw) => haystack.includes(kw));
}

// The distilled form of one skill's body: the explicit marker section when
// present, else a truncation at the last paragraph boundary that fits.
export function distillSkill(body) {
  const m = DISTILL_MARKER.exec(body);
  if (m) return body.slice(0, m.index).trim();
  if (body.length <= DISTILL_MAX_CHARS) return body;
  const head = body.slice(0, DISTILL_MAX_CHARS);
  const cut = head.lastIndexOf('\n\n');
  return (cut > 0 ? head.slice(0, cut) : head).trim();
}

// Every *.md in a directory, sorted by name. Missing dir → [].
async function readSkillDir(dir, origin) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  const skills = [];
  for (const file of names.filter((n) => n.endsWith('.md')).sort()) {
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    skills.push(parseSkill(file.slice(0, -3), origin, raw));
  }
  return skills;
}

// Read config-listed project files (the `skills` and `projectContext` keys)
// through the file-server guard. Rejected/missing entries are skipped and
// logged so a config typo is visible on the runner console.
async function readProjectEntries(entries, config, { origin, alwaysApplies, log }) {
  const root = typeof config?.root === 'string' ? config.root : null;
  const skills = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (root === null) {
      log(`redline: ${origin} "${entry}" skipped (no served root available)`);
      continue;
    }
    const abs = resolvePath(root, '/' + entry.replace(/^\/+/, ''));
    if (abs === null) {
      log(`redline: ${origin} "${entry}" skipped (outside the served root or a dotfile)`);
      continue;
    }
    let raw;
    try {
      raw = await fs.readFile(abs, 'utf8');
    } catch {
      log(`redline: ${origin} "${entry}" skipped (not readable under the served root)`);
      continue;
    }
    const skill = parseSkill(entry, origin, raw);
    if (alwaysApplies) skill.hasHeader = false; // projectContext: never filtered
    skills.push(skill);
  }
  return skills;
}

// List every known skill, unfiltered — the router (WP3) shows these to the
// model so it can name the relevant ones.
export async function listSkills({ config, env = process.env, log = console.warn } = {}) {
  return [
    ...await readSkillDir(PACKAGED_SKILLS_DIR, 'packaged'),
    ...await readSkillDir(userSkillsDir(env), 'user'),
    ...await readProjectEntries(config?.skills, config, { origin: 'project', alwaysApplies: false, log }),
    ...await readProjectEntries(config?.projectContext, config, { origin: 'projectContext', alwaysApplies: true, log }),
  ];
}

// Section text for one selected skill. Packaged bodies render bare (they ARE
// the editing rules); user/project skills get a labeled heading so the agent
// knows where a rule came from.
function renderSkill(skill, distilled) {
  const body = distilled ? distillSkill(skill.body) : skill.body;
  if (skill.origin === 'packaged') return body;
  if (skill.origin === 'projectContext') return `## Project context: ${skill.name}\n\n${body}`;
  return `## Skill: ${skill.name} (${skill.origin})\n\n${body}`;
}

// Assemble the relevant skill text for one run. `only` (optional, from the
// router) narrows the non-default selection to the named skills. Returns
// {skills, text}; never throws for a bad config entry.
export async function loadSkills({
  comment = '', archetype, config, distilled = false, only = null,
  env = process.env, log = console.warn,
} = {}) {
  const all = await listSkills({ config, env, log });
  const selected = all.filter((skill) => {
    if (!skillApplies(skill, { archetype, comment })) return false;
    if (only === null) return true;
    // The packaged packs (default + the archetype's own) and always-on
    // project context survive any narrowing — the router only gates the
    // optional skills, never the lane's editing rules.
    if (skill.origin === 'packaged' && (skill.name === 'default' || ARCHETYPES.includes(skill.name))) return true;
    if (skill.origin === 'projectContext') return true;
    return only.includes(skill.name);
  });
  return {
    skills: selected.map(({ name, origin }) => ({ name, origin })),
    text: selected.map((skill) => renderSkill(skill, distilled)).join('\n\n---\n\n'),
  };
}

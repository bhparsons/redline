// test/runner/skills.test.mjs — WP0: the skill system.
//
// Covers parseSkill metadata headers, skillApplies selection (packaged
// name-pinning, archetype lists, comment keywords, headerless = always),
// distillSkill (marker, paragraph-boundary truncation, short passthrough),
// user skills via REDLINE_SKILLS_DIR, project skills via config `skills`
// (traversal-guard rejection logged, never thrown), router narrowing via
// `only`, and the config `skills` key validation. The packaged packs
// (runner/skills/*.md) keep their loadContext selection semantics — that
// stays covered by context.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSkill, skillApplies, distillSkill, DISTILL_MAX_CHARS,
  listSkills, loadSkills, userSkillsDir, PACKAGED_SKILLS_DIR,
} from '../../runner/lib/skills.mjs';
import { CONFIG_FILENAME, loadConfig } from '../../runner/lib/config.mjs';

// Isolate from any real ~/.redline/skills on the dev machine.
const EMPTY_USER_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-skills-none-'));
process.env.REDLINE_SKILLS_DIR = EMPTY_USER_DIR;

const noLog = { log: () => {} };

test('parseSkill + skillApplies', async (t) => {
  await t.test('header parsed and stripped from the body', () => {
    const skill = parseSkill('voice', 'user',
      '<!-- redline-skill\narchetypes: content, redesign\nkeywords: tone, voice\n-->\n# Voice guide\n\nBody.');
    assert.deepEqual(skill.meta, { archetypes: ['content', 'redesign'], keywords: ['tone', 'voice'] });
    assert.equal(skill.body, '# Voice guide\n\nBody.');
    assert.equal(skill.hasHeader, true);
  });

  await t.test('no header → applies everywhere', () => {
    const skill = parseSkill('notes', 'user', 'Just some rules.');
    assert.equal(skill.hasHeader, false);
    assert.ok(skillApplies(skill, { archetype: 'tactical', comment: 'anything' }));
  });

  await t.test('archetype list and comment keywords select; neither → excluded', () => {
    const skill = parseSkill('voice', 'user',
      '<!-- redline-skill\narchetypes: content\nkeywords: friendly\n-->\nBody.');
    assert.ok(skillApplies(skill, { archetype: 'content', comment: 'x' }), 'archetype match');
    assert.ok(skillApplies(skill, { archetype: 'tactical', comment: 'Make this FRIENDLY.' }), 'keyword match, case-insensitive');
    assert.ok(!skillApplies(skill, { archetype: 'tactical', comment: 'Fix the date.' }), 'no match');
  });

  await t.test('packaged packs are pinned by name regardless of headers', () => {
    const def = parseSkill('default', 'packaged', 'rules');
    const redesign = parseSkill('redesign', 'packaged', 'rules');
    assert.ok(skillApplies(def, { archetype: 'tactical' }), 'default always');
    assert.ok(skillApplies(redesign, { archetype: 'redesign' }));
    assert.ok(!skillApplies(redesign, { archetype: 'content' }));
  });
});

test('distillSkill', async (t) => {
  await t.test('explicit marker wins', () => {
    const body = 'Short form here.\n<!-- distill-end -->\nLong form follows.';
    assert.equal(distillSkill(body), 'Short form here.');
  });

  await t.test('short body passes through untouched', () => {
    assert.equal(distillSkill('tiny'), 'tiny');
  });

  await t.test('long body truncates at a paragraph boundary inside the cap', () => {
    const para = 'A paragraph of skill text that repeats itself for length. '.repeat(4).trim();
    const body = Array.from({ length: 10 }, () => para).join('\n\n');
    const distilled = distillSkill(body);
    assert.ok(distilled.length <= DISTILL_MAX_CHARS);
    assert.ok(body.startsWith(distilled), 'distilled form is a prefix — never invented content');
    assert.ok(!distilled.endsWith(' '), 'clean cut');
  });
});

test('loadSkills across origins', async (t) => {
  const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-skills-user-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-skills-root-'));
  t.after(async () => {
    await fs.rm(userDir, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  const env = { REDLINE_SKILLS_DIR: userDir };

  await fs.writeFile(path.join(userDir, 'always.md'), 'USER-ALWAYS-SKILL\n');
  await fs.writeFile(path.join(userDir, 'voice.md'),
    '<!-- redline-skill\nkeywords: tone\n-->\nUSER-VOICE-SKILL\n');
  await fs.writeFile(path.join(userDir, 'not-a-skill.txt'), 'IGNORED-NOT-MARKDOWN\n');
  await fs.writeFile(path.join(root, 'house.md'), 'PROJECT-HOUSE-SKILL\n');
  await fs.writeFile(path.join(root, 'ctx.md'), 'PROJECT-CTX-FILE\n');
  const config = { root, skills: ['house.md'], projectContext: ['ctx.md'] };

  await t.test('packaged + user + project assemble; keyword skill only when matched', async () => {
    const miss = await loadSkills({ comment: 'Fix the date.', archetype: 'tactical', config, env, ...noLog });
    assert.ok(miss.text.includes('# Default editing rules'), 'packaged default present');
    assert.ok(miss.text.includes('USER-ALWAYS-SKILL'), 'headerless user skill present');
    assert.ok(miss.text.includes('## Skill: house.md (project)'), 'project skill labeled');
    assert.ok(miss.text.includes('## Project context: ctx.md'), 'projectContext labeled as before');
    assert.ok(!miss.text.includes('USER-VOICE-SKILL'), 'keyword skill absent without a match');
    assert.ok(!miss.text.includes('IGNORED-NOT-MARKDOWN'), 'non-.md files ignored');

    const hit = await loadSkills({ comment: 'Adjust the tone here.', archetype: 'tactical', config, env, ...noLog });
    assert.ok(hit.text.includes('USER-VOICE-SKILL'), 'keyword skill present on a match');
    assert.deepEqual(hit.skills.find((s) => s.name === 'voice'),
      { name: 'voice', origin: 'user' });
  });

  await t.test('distilled: true distills every selected skill', async () => {
    await fs.writeFile(path.join(userDir, 'longform.md'),
      'DISTILLED-HEAD\n<!-- distill-end -->\nLONGFORM-TAIL\n');
    const out = await loadSkills({ comment: '', archetype: 'tactical', config, env, distilled: true, ...noLog });
    assert.ok(out.text.includes('DISTILLED-HEAD'));
    assert.ok(!out.text.includes('LONGFORM-TAIL'), 'marker tail dropped in distilled mode');
    await fs.rm(path.join(userDir, 'longform.md'));
  });

  await t.test('router narrowing via `only` keeps default + projectContext', async () => {
    const out = await loadSkills({
      comment: 'Adjust the tone here.', archetype: 'tactical', config, env,
      only: ['voice'], ...noLog,
    });
    assert.ok(out.text.includes('# Default editing rules'), 'default pack survives');
    assert.ok(out.text.includes('PROJECT-CTX-FILE'), 'projectContext survives');
    assert.ok(out.text.includes('USER-VOICE-SKILL'), 'named skill kept');
    assert.ok(!out.text.includes('USER-ALWAYS-SKILL'), 'unnamed skill dropped');
    assert.ok(!out.text.includes('PROJECT-HOUSE-SKILL'), 'unnamed project skill dropped');
  });

  await t.test('traversal/dotfile skill entries are rejected and logged, never thrown', async () => {
    const logged = [];
    const out = await loadSkills({
      comment: '', archetype: 'tactical',
      config: { root, skills: ['../escape.md', '.hidden.md', 'missing.md'] },
      env, log: (msg) => logged.push(msg),
    });
    assert.ok(!out.text.includes('escape'), 'nothing outside the root');
    assert.equal(logged.length, 3, 'each bad entry logged');
  });

  await t.test('listSkills names every origin for the router', async () => {
    const all = await listSkills({ config, env, log: () => {} });
    const names = all.map((s) => `${s.origin}:${s.name}`);
    assert.ok(names.includes('packaged:default'));
    assert.ok(names.includes('user:voice'));
    assert.ok(names.includes('project:house.md'));
    assert.ok(names.includes('projectContext:ctx.md'));
  });
});

test('skills config + environment plumbing', async (t) => {
  await t.test('userSkillsDir: env override, else ~/.redline/skills', () => {
    assert.equal(userSkillsDir({ REDLINE_SKILLS_DIR: '/x/skills' }), '/x/skills');
    assert.equal(userSkillsDir({}), path.join(os.homedir(), '.redline', 'skills'));
  });

  await t.test('packaged dir exists and exposes the five packs', async () => {
    const names = (await fs.readdir(PACKAGED_SKILLS_DIR)).filter((n) => n.endsWith('.md')).sort();
    assert.deepEqual(names, ['accessibility.md', 'content.md', 'default.md', 'redesign.md', 'research.md']);
  });

  await t.test('config `skills` key: accepted, defaulted, validated', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-skillscfg-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const write = (obj) => fs.writeFile(path.join(dir, CONFIG_FILENAME), JSON.stringify(obj));

    assert.deepEqual((await loadConfig(dir, {})).skills, []);
    await write({ skills: ['guides/voice.md'] });
    assert.deepEqual((await loadConfig(dir, {})).skills, ['guides/voice.md']);
    for (const bad of [{ skills: 'voice.md' }, { skills: [42] }, { skills: [''] }]) {
      await write(bad);
      await assert.rejects(() => loadConfig(dir, {}), new RegExp(CONFIG_FILENAME), JSON.stringify(bad));
    }
  });
});

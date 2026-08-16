// runner/lib/onboarding.mjs — first-run CLI setup.
//
// maybeRunOnboarding({root, ...}) runs BEFORE loadConfig in runner/index.mjs.
// When the served root has no redline.config.json AND stdin is interactive,
// it asks four things and writes a pretty-printed redline.config.json:
//   1. a style guide / CSS-conventions file (optional → projectContext)
//   2. preferred models per archetype (Enter accepts the default)
//   3. an OpenRouter API key (optional — env OPENROUTER_API_KEY wins)
//   4. an OTLP telemetry endpoint (Enter keeps the local-Phoenix default,
//      "off" disables export)
//
// Skip conditions (all silent):
//   - redline.config.json already exists           → never re-onboard
//   - stdin is not a TTY                           → non-interactive start
//   - the --no-onboarding flag (skip: true)        → explicit opt-out
//
// REDLINE_ONBOARDING=force treats a non-TTY stdin as interactive — that is
// how tests drive the flow through a child process with piped answers. EOF
// on stdin mid-flow accepts the defaults for every remaining question rather
// than hanging or crashing.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { CONFIG_FILENAME, DEFAULT_MODELS, DEFAULT_OTEL_ENDPOINT } from './config.mjs';
import { ARCHETYPES } from './classify.mjs';

function validHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// A line source that QUEUES input lines. rl.question() drops any line that
// arrives while no question is pending — with piped stdin (scripted setup)
// all answers land in one chunk and every line after the first would be
// lost. Queueing makes the flow correct for both a real TTY and a pipe;
// EOF resolves every later question with '' (accept the default).
function lineSource(rl, output) {
  const queue = [];
  let pending = null;
  let done = false;
  rl.on('line', (line) => {
    if (pending) { const p = pending; pending = null; p(line); } else queue.push(line);
  });
  rl.once('close', () => {
    done = true;
    if (pending) { const p = pending; pending = null; p(''); }
  });
  return {
    ask(question) {
      output.write(question);
      if (queue.length > 0) return Promise.resolve(queue.shift().trim());
      if (done) return Promise.resolve('');
      return new Promise((resolve) => { pending = (line) => resolve(line.trim()); });
    },
  };
}

export async function maybeRunOnboarding({
  root,
  skip = false,
  input = process.stdin,
  output = process.stdout,
  env = process.env,
} = {}) {
  if (skip) return { ran: false, reason: 'flag' };

  const configPath = path.join(root, CONFIG_FILENAME);
  try {
    await fs.access(configPath);
    return { ran: false, reason: 'existing-config' };
  } catch { /* no config — candidate for onboarding */ }

  const interactive = input.isTTY === true || env.REDLINE_ONBOARDING === 'force';
  if (!interactive) return { ran: false, reason: 'not-a-tty' };

  const rl = createInterface({ input, output });
  const lines = lineSource(rl, output);

  try {
    output.write('redline first-run setup — press Enter to accept any default.\n');

    // 1. Style guide / CSS conventions → projectContext.
    const styleGuide = await lines.ask(
      `Style guide or CSS-conventions file (path under ${root}; Enter to skip): `);
    if (styleGuide !== '') {
      try {
        await fs.access(path.resolve(root, styleGuide));
      } catch {
        output.write(`  note: "${styleGuide}" does not exist yet — it will be picked up once it does.\n`);
      }
    }

    // 2. Models per archetype (Enter keeps the default).
    const models = {};
    for (const archetype of ARCHETYPES) {
      const answer = await lines.ask(
        `Model for ${archetype} [${DEFAULT_MODELS[archetype]}]: `);
      if (answer !== '') models[archetype] = answer;
    }

    // 3. OpenRouter API key (Enter to use env OPENROUTER_API_KEY; Enter to
    // skip only if the key is already in the environment). Stored in the
    // config as agent.apiKey; the env variable still wins at runtime.
    let apiKey = '';
    const envKey = typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.length > 0
      ? env.OPENROUTER_API_KEY : null;
    if (envKey) {
      output.write('  using OPENROUTER_API_KEY from environment; skipping key question.\n');
    } else {
      apiKey = await lines.ask(
        'OpenRouter API key (Enter to skip and set OPENROUTER_API_KEY later): ');
      if (apiKey !== '') {
        output.write('  storing key in redline.config.json; set OPENROUTER_API_KEY instead to keep it out of the file.\n');
      }
    }

    // 4. Telemetry endpoint (Enter keeps the local-Phoenix default; "off"
    // writes an explicit endpoint:null so export stays disabled).
    let telemetryEndpoint = await lines.ask(
      `OTLP telemetry endpoint [${DEFAULT_OTEL_ENDPOINT}] ("off" to disable): `);
    if (telemetryEndpoint !== '' && telemetryEndpoint !== 'off' && !validHttpUrl(telemetryEndpoint)) {
      output.write(`  note: "${telemetryEndpoint}" is not an http(s) URL — keeping the default.\n`);
      telemetryEndpoint = '';
    }

    const config = {};
    if (styleGuide !== '') config.projectContext = [styleGuide];
    if (Object.keys(models).length > 0) config.models = models;
    if (apiKey !== '') config.agent = { apiKey };
    if (telemetryEndpoint === 'off') config.telemetry = { endpoint: null };
    else if (telemetryEndpoint !== '') config.telemetry = { endpoint: telemetryEndpoint };

    // Written even when empty: an existing (empty) config is what marks
    // onboarding as done, so the questions never repeat on later starts.
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    output.write(`wrote ${configPath}\n`);
    return { ran: true, configPath, config };
  } finally {
    rl.close();
  }
}

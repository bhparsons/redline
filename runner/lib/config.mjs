// runner/lib/config.mjs — redline.config.json loading + validation.
//
// The config file is OPTIONAL and lives at the root of the served directory
// (<root>/redline.config.json). Absence → defaults. Invalid JSON, unknown
// keys, or wrongly-typed values → a thrown Error at startup with a clear
// message (never a silent fallback).
//
// Resolution rules:
//   - apiKey:   env OPENROUTER_API_KEY  → config agent.apiKey  → null
//   - endpoint: env OPENROUTER_ENDPOINT → config agent.endpoint → default
//     (the env/config override exists so tests can point at a local stub).
//   - telemetry.endpoint: env REDLINE_OTEL_ENDPOINT → config → local Phoenix
//     default (http://127.0.0.1:6006/v1/traces). Export is fire-and-forget,
//     so a Phoenix that isn't running costs nothing but one quiet failed
//     POST. Explicit OFF: `"telemetry": {"endpoint": null}` in the config, or
//     REDLINE_OTEL_ENDPOINT=off in the env.
//
// SECURITY: the resolved config carries the API key. It must never be
// serialized into an HTTP response or log line, and the file server refuses
// to serve redline.config.json (see server.mjs). Validation error messages
// below never embed the value of agent.apiKey.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ARCHETYPES } from './classify.mjs';
import { TIERS, DEFAULT_MODEL_TIERS } from '../config/defaults.mjs';

export { TIERS, DEFAULT_MODEL_TIERS };

export const CONFIG_FILENAME = 'redline.config.json';

export const DEFAULT_RUNNER_PORT = 5175;
export const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// What this bounds changed with #139. On the STREAMING path (the standard lane)
// it is the wait for the FIRST chunk only — after that the clock is
// STREAM_IDLE_MS between chunks, with no total cap, because a reply that keeps
// arriving is work in progress and hanging up on it was the thing we were
// trying to stop doing. On the non-streaming path (router, tactical) it is
// still total elapsed, which is fine there: those replies are small by
// construction.
//
// It was 60_000 until 2026-07-27 and briefly 300_000 as an interim, when the
// ceiling went to MODEL_MAX (#130) and a long reply could no longer fit the old
// window. Kept generous: a first chunk that has not arrived in five minutes is
// a dead connection, not a thoughtful model.
export const DEFAULT_TIMEOUT_MS = 300_000;
// Arize Phoenix run locally — the default trace UI (frontload decision 2).
export const DEFAULT_OTEL_ENDPOINT = 'http://127.0.0.1:6006/v1/traces';

// OpenRouter model slugs per archetype. Structure matters more than the
// exact ids — override any of these in redline.config.json.
//
// This map is NOT the normal path. It is reached only via modelForRoute when
// the router's own classification call FAILED (route.source === 'fallback'),
// so the archetype came from the keyword classifier rather than a model.
//
// DECISION (2026-07-24, Blake): capability over cost here. These are the runs
// where we are least confident about what the comment is asking for, they are
// rare by construction, and opus-4-8 is the most capable model on the account.
// That is deliberately the OPPOSITE trade from modelTiers.complex, which moved
// off opus the same day on eval evidence (see runner/config/defaults.mjs) —
// there the archetype is known and cost is paid on every run; here it is not
// and it is not. Untested by the eval harness, which measures the tier ladder,
// not this map — see the eval backlog ticket.
//
// `research` keeps perplexity/sonar-pro: it is the only entry with native web
// search, and this transport sends no tools, so an opus substitution would
// silently drop the capability the archetype exists for.
//
// NOTE: this map is not an outage failover. Four of five entries are Anthropic,
// and there is no retry or cross-provider fallback in lib/agent.mjs — an
// Anthropic outage fails the revise call outright, and never reaches here.
export const DEFAULT_MODELS = Object.freeze({
  tactical: 'anthropic/claude-opus-4-8',        // routing failed — favour capability
  redesign: 'anthropic/claude-opus-4-8',
  research: 'perplexity/sonar-pro',             // native web search; see note above
  accessibility: 'anthropic/claude-opus-4-8',
  content: 'anthropic/claude-opus-4-8',
});

function fail(message) {
  throw new Error(`${CONFIG_FILENAME}: ${message}`);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertKnownKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`unknown key ${label}${key} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function validHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Load and validate <root>/redline.config.json, merging env overrides and
// defaults. `env` is injectable for tests; defaults to process.env.
export async function loadConfig(root, env = process.env) {
  let raw = null;
  try {
    raw = await fs.readFile(path.join(root, CONFIG_FILENAME), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
  }

  let file = {};
  if (raw !== null) {
    try {
      file = JSON.parse(raw);
    } catch (err) {
      fail(`invalid JSON (${err.message})`);
    }
    assertPlainObject(file, 'top level');
    assertKnownKeys(file, ['runnerPort', 'agent', 'models', 'modelTiers', 'telemetry', 'projectContext', 'skills'], '');
  }

  // runnerPort
  let runnerPort = DEFAULT_RUNNER_PORT;
  if (file.runnerPort !== undefined) {
    if (!Number.isInteger(file.runnerPort) || file.runnerPort < 0 || file.runnerPort > 65535) {
      fail('runnerPort must be an integer between 0 and 65535');
    }
    runnerPort = file.runnerPort;
  }

  // agent
  let fileAgent = {};
  if (file.agent !== undefined) {
    assertPlainObject(file.agent, 'agent');
    assertKnownKeys(file.agent, ['adapter', 'apiKey', 'endpoint', 'timeoutMs'], 'agent.');
    fileAgent = file.agent;
  }
  if (fileAgent.adapter !== undefined && fileAgent.adapter !== 'openrouter') {
    fail('agent.adapter must be "openrouter" (the only supported adapter)');
  }
  if (fileAgent.apiKey !== undefined && (typeof fileAgent.apiKey !== 'string' || fileAgent.apiKey.length === 0)) {
    fail('agent.apiKey must be a non-empty string');
  }
  if (fileAgent.endpoint !== undefined && (typeof fileAgent.endpoint !== 'string' || !validHttpUrl(fileAgent.endpoint))) {
    fail('agent.endpoint must be an http(s) URL');
  }
  if (fileAgent.timeoutMs !== undefined
    && (!Number.isInteger(fileAgent.timeoutMs) || fileAgent.timeoutMs <= 0)) {
    fail('agent.timeoutMs must be a positive integer (milliseconds)');
  }

  // models — per-archetype ids. File entries are ALSO kept separately as
  // modelOverrides: an author who pinned a model for an archetype keeps it
  // even when the router's tier would pick differently (lib/router.mjs).
  const models = { ...DEFAULT_MODELS };
  const modelOverrides = {};
  if (file.models !== undefined) {
    assertPlainObject(file.models, 'models');
    assertKnownKeys(file.models, [...ARCHETYPES], 'models.');
    for (const [key, value] of Object.entries(file.models)) {
      if (typeof value !== 'string' || value.length === 0) {
        fail(`models.${key} must be a non-empty string model id`);
      }
      models[key] = value;
      modelOverrides[key] = value;
    }
  }

  // modelTiers — the router's simple/standard/complex ladder (WP3).
  const modelTiers = { ...DEFAULT_MODEL_TIERS };
  if (file.modelTiers !== undefined) {
    assertPlainObject(file.modelTiers, 'modelTiers');
    assertKnownKeys(file.modelTiers, [...TIERS], 'modelTiers.');
    for (const [key, value] of Object.entries(file.modelTiers)) {
      if (typeof value !== 'string' || value.length === 0) {
        fail(`modelTiers.${key} must be a non-empty string model id`);
      }
      modelTiers[key] = value;
    }
  }

  // projectContext + skills: author-supplied files, paths relative to the
  // served root. Existence/traversal is checked at prompt-render time
  // (lib/skills.mjs) so a moved file degrades to a logged skip, not a
  // startup failure. projectContext files are always in scope; skills files
  // may carry a relevance header (see lib/skills.mjs).
  const pathList = (key) => {
    if (file[key] === undefined) return [];
    if (!Array.isArray(file[key])) {
      fail(`${key} must be an array of file paths`);
    }
    for (const entry of file[key]) {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > 1024) {
        fail(`${key} entries must be non-empty path strings`);
      }
    }
    return [...file[key]];
  };
  const projectContext = pathList('projectContext');
  const skills = pathList('skills');

  // telemetry (default ON, pointed at local Phoenix; endpoint null = OFF)
  let fileTelemetry = {};
  if (file.telemetry !== undefined) {
    assertPlainObject(file.telemetry, 'telemetry');
    assertKnownKeys(file.telemetry, ['endpoint', 'headers', 'format'], 'telemetry.');
    fileTelemetry = file.telemetry;
  }
  if (fileTelemetry.format !== undefined
    && fileTelemetry.format !== 'protobuf' && fileTelemetry.format !== 'json') {
    fail('telemetry.format must be "protobuf" (default; what Phoenix accepts) or "json"');
  }
  if (fileTelemetry.endpoint !== undefined && fileTelemetry.endpoint !== null
    && (typeof fileTelemetry.endpoint !== 'string' || !validHttpUrl(fileTelemetry.endpoint))) {
    fail('telemetry.endpoint must be an http(s) URL, or null to turn telemetry off');
  }
  let telemetryHeaders = {};
  if (fileTelemetry.headers !== undefined) {
    assertPlainObject(fileTelemetry.headers, 'telemetry.headers');
    for (const [key, value] of Object.entries(fileTelemetry.headers)) {
      if (typeof value !== 'string') {
        fail(`telemetry.headers.${key} must be a string`);
      }
    }
    telemetryHeaders = { ...fileTelemetry.headers };
  }

  // Env wins over config for the key; same precedence for the endpoints.
  const envKey = typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.length > 0
    ? env.OPENROUTER_API_KEY : null;
  const envEndpoint = typeof env.OPENROUTER_ENDPOINT === 'string' && env.OPENROUTER_ENDPOINT.length > 0
    ? env.OPENROUTER_ENDPOINT : null;
  const envOtel = typeof env.REDLINE_OTEL_ENDPOINT === 'string' && env.REDLINE_OTEL_ENDPOINT.length > 0
    ? env.REDLINE_OTEL_ENDPOINT : undefined;

  // Endpoint resolution: env (the string "off" = OFF) → config (JSON null =
  // OFF) → the local-Phoenix default.
  let otelEndpoint;
  if (envOtel !== undefined) {
    otelEndpoint = envOtel === 'off' ? null : envOtel;
  } else if (fileTelemetry.endpoint !== undefined) {
    otelEndpoint = fileTelemetry.endpoint; // string URL, or null = OFF
  } else {
    otelEndpoint = DEFAULT_OTEL_ENDPOINT;
  }

  return {
    // The served root the config was loaded from — carried so consumers that
    // resolve config-relative paths (lib/context.mjs) can traversal-guard
    // against it without a separate parameter.
    root: path.resolve(root),
    runnerPort,
    projectContext,
    skills,
    agent: {
      adapter: 'openrouter',
      apiKey: envKey ?? fileAgent.apiKey ?? null,
      endpoint: envEndpoint ?? fileAgent.endpoint ?? DEFAULT_ENDPOINT,
      timeoutMs: fileAgent.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
    models,
    modelOverrides,
    modelTiers,
    telemetry: {
      endpoint: otelEndpoint,
      headers: telemetryHeaders,
      format: fileTelemetry.format ?? 'protobuf',
    },
  };
}

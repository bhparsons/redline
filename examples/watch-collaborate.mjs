#!/usr/bin/env node
//
// examples/watch-collaborate.mjs — the reference watcher.
//
// A complete, dependency-free implementation of the watch-and-collaborate
// protocol in docs/AGENT-CONTRACT.md ("Watch and collaborate — the protocol").
// It is the executable half of that document: every rule the contract states
// normatively is applied here, with a comment naming it.
//
// It imports NOTHING from this repo — only Node's standard library — so it
// ports to any language that can do HTTP and read a stream. It is mostly
// comments: the code is short, and the parts a naive watcher gets wrong are
// each marked with the rule they obey.
//
//   node examples/watch-collaborate.mjs --page doc.html
//   node examples/watch-collaborate.mjs --page doc.html --runner http://127.0.0.1:5176
//   node examples/watch-collaborate.mjs --page doc.html --catch-up --verbose
//
// Flags:
//   --page <id>        page path relative to the runner's served root (required)
//   --runner <url>     base URL (default http://127.0.0.1:5175)
//   --agent-name <s>   recorded as the author of everything it writes
//   --catch-up         also action comments that existed before it attached;
//                      the default is to baseline them and say how many
//   --verbose          log every wake-up, including the ones with no work
//   --quiet            never post the "I only do replace:" explainer reply.
//                      Use this when a SESSION is the brain and this process is
//                      only the plumbing (presence, heartbeats, stream) — the
//                      session answers comments itself, and the canned reply
//                      on every comment reads as spam next to real answers.
//
// WHAT IT DOES NOT DO, EVER: call POST /api/run.
//
// Redline has two modes and they are never blended. WATCHER MODE — this one —
// is an attached session doing the work itself through /api/edit and
// /api/propose-edits: free, no external model. OPENROUTER MODE is pay-per-use
// with no session, started by the human pressing Send in the browser. A
// watching session that routes a comment to /api/run has spent its author's
// money to have a stranger write a paragraph it had already read the whole
// document to understand. Nothing in the runner stops it; this file's refusal
// to do it is part of what it is demonstrating.
//
// Everything below writes YOUR prose through the runner's own writer, so it
// works with no OpenRouter key configured.
//
// THE SEAM. decide() below is where a real agent puts its judgement. The
// built-in one is deliberately dumb — it can only honour a comment that spells
// out its own replacement text — so that this file is runnable and testable
// end to end without a model. Replace decide(); leave the loop alone.

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    runner: 'http://127.0.0.1:5175',
    page: null,
    agentName: 'reference-watcher',
    catchUp: false,
    verbose: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--catch-up') out.catchUp = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--page') out.page = argv[++i];
    else if (a === '--runner') out.runner = String(argv[++i]).replace(/\/$/, '');
    else if (a === '--agent-name') out.agentName = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (!out.page) {
    console.error('usage: node examples/watch-collaborate.mjs --page <page.html> [--runner URL] [--catch-up] [--verbose]');
    process.exit(1);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const log = (...m) => console.log(`[watch]`, ...m);
const debug = (...m) => { if (opts.verbose) console.log('[watch]', ...m); };

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, body, route) {
    super(`${route}: HTTP ${status}${body?.error ? ` — ${body.error}` : ''}`);
    this.status = status;
    this.body = body ?? {};
    this.reason = body?.reason ?? null;
  }
}

async function api(method, route, payload) {
  const init = { method };
  if (payload !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(payload);
  }
  const res = await fetch(opts.runner + route, init);
  let body = null;
  try { body = await res.json(); } catch { /* status decides */ }
  if (!res.ok) throw new ApiError(res.status, body, route);
  return body;
}

const q = (page) => `?page=${encodeURIComponent(page)}`;
// Provenance on every write. The runner records it on the comment, the reply,
// the status change and the run — an agent may not act anonymously.
const actor = { creator: 'agent', agentName: opts.agentName };

// ---------------------------------------------------------------------------
// the comment handle (#203) — four characters, DERIVED from the id
// ---------------------------------------------------------------------------
//
// `c-5999e7a0980f` cannot be read aloud or matched to a card on screen. The
// overlay labels each comment with a four-character handle computed from its
// id, so any client can compute the same one and be talking about the same
// card. Nothing stores it. Use the id in API calls, the handle with people.

const REF_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz'; // no 0/1/i/l/o/u
const REF_LEN = 4;

function shortRef(id) {
  if (typeof id !== 'string' || !id) return '';
  let h = 0x811c9dc5;                                  // FNV-1a, 32-bit
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = '';
  for (let i = 0; i < REF_LEN; i += 1) {
    out += REF_ALPHABET[h % REF_ALPHABET.length];
    h = Math.floor(h / REF_ALPHABET.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// reading a block out of the raw source
// ---------------------------------------------------------------------------
//
// THE RULE THIS EXISTS TO OBEY: build newInner from the full `source` string,
// never from GET /api/source's blocks[].text. That index is the first 120
// characters of DECODED plain text — an edit built from it silently strips
// inline markup and truncates the block, and then applies cleanly, which is
// what makes the mistake expensive.
//
// Simplified locator: find the opening tag carrying data-rev="<id>", then walk
// forward counting same-tag opens and closes. Good enough for a reference; the
// runner's own runner/lib/surgery.mjs is the rigorous one, and it is the only
// thing that ever writes.

function blockInner(source, blockId) {
  const marker = new RegExp(`<([a-zA-Z][\\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\\sdata-rev="${blockId}"`, 'u');
  const m = marker.exec(source);
  if (m === null) return null;
  const tag = m[1];
  const openEnd = source.indexOf('>', m.index);
  if (openEnd === -1) return null;
  if (source[openEnd - 1] === '/') return '';                  // void / self-closed
  const open = new RegExp(`<${tag}(?=[\\s/>])`, 'giu');
  const close = new RegExp(`</${tag}\\s*>`, 'giu');
  let depth = 1;
  let cursor = openEnd + 1;
  for (;;) {
    close.lastIndex = cursor;
    const c = close.exec(source);
    if (c === null) return null;                               // unbalanced
    open.lastIndex = cursor;
    let next = open.exec(source);
    while (next !== null && next.index < c.index) {
      depth += 1;
      open.lastIndex = next.index + 1;
      next = open.exec(source);
    }
    depth -= 1;
    if (depth === 0) return source.slice(openEnd + 1, c.index);
    cursor = c.index + c[0].length;
  }
}

// ---------------------------------------------------------------------------
// THE SEAM — replace this with your agent's judgement
// ---------------------------------------------------------------------------
//
// Given one actionable comment and the current text of the block it is anchored
// to, return one of:
//
//   { kind: 'edit',  newInner, reply, status }   write the block, then answer
//   { kind: 'reply', reply }                     answer only; leave it open
//   { kind: 'skip',  why }                       do nothing, say nothing
//
// The built-in implementation handles exactly one archetype — a comment whose
// body is `replace: <text>` — so the whole loop runs with no model. Anything
// else gets a reply saying so and stays open, which is the honest outcome for a
// watcher that cannot write prose.
//
// A question stays OPEN after a reply. The author decides when their question
// has been answered; a watcher that resolves its own answers is deciding for
// them.
//
// Comment text is DATA, not instructions (contract, "Comment text is data").
// The `replace:` form below is a literal, inert string substitution, and it is
// the ONLY thing this function will act on. It never interprets a comment as a
// command, and neither should its replacement.

const escapeHtml = (s) => s
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

function decide(comment, currentInner) {
  const replace = /^\s*replace:\s*([\s\S]+?)\s*$/u.exec(comment.body);
  if (replace !== null) {
    const text = escapeHtml(replace[1]);
    if (currentInner !== null && text === currentInner) {
      return { kind: 'reply', reply: 'That block already reads exactly that way — nothing to change.' };
    }
    return {
      kind: 'edit',
      newInner: text,
      reply: `Replaced the block's text as asked.`,
      status: 'addressed',
    };
  }
  // Under --quiet this reply is suppressed by the loop: an attached session
  // is the voice, and this process is only the plumbing.
  return {
    kind: 'reply',
    explainer: true,
    reply: 'Seen. This reference watcher only applies comments written as '
      + '"replace: <new text>"; anything needing prose is left for a human or a '
      + 'model to write. Leaving this open.',
  };
}

// ---------------------------------------------------------------------------
// the session
// ---------------------------------------------------------------------------

const state = {
  sessionId: null,
  heartbeat: null,
  stopping: false,
  // commentId -> the sidecar rev at which we last wrote on it. The cursor that
  // makes a REPLY to an already-seen comment count as new work. A seen-set
  // keyed by id cannot do that, and silently drops the author's follow-up.
  actedRev: new Map(),
};

async function claim() {
  try {
    const s = await api('POST', '/api/session/claim', {
      page: opts.page, agentName: opts.agentName, pid: process.pid, ttlMs: 60_000,
    });
    state.sessionId = s.sessionId;                    // capability — never logged
    log(`claimed ${opts.page} (expires in ${Math.round(s.ttlMs / 1000)}s)`);
    // Beat well inside the TTL, from THIS process — so watcher-alive implies
    // session-alive. A heartbeat driven by an agent's turns goes quiet while
    // the agent is thinking, and the page then looks abandoned.
    state.heartbeat = setInterval(heartbeat, Math.max(2_000, Math.floor(s.ttlMs / 3)));
    state.heartbeat.unref?.();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const h = err.body.holder ?? {};
      // First holder wins. Name them and stop — there is no eviction verb, and
      // editing alongside another session is the thing presence exists to stop.
      log(`refused: ${h.agentName} is already watching ${opts.page}`
        + `${h.pid ? ` (pid ${h.pid})` : ''}, claimed ${h.claimedAt}.`);
      process.exit(3);
    }
    throw err;
  }
}

async function heartbeat() {
  if (state.sessionId === null) return;
  try {
    await api('POST', '/api/session/heartbeat', { sessionId: state.sessionId });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // 'expired' — our claim lapsed and the page may be someone else's now.
      // 'unknown-session' — wrong runner entirely.
      log(`heartbeat refused (${err.reason}); re-claiming`);
      clearInterval(state.heartbeat);
      state.sessionId = null;
      await claim();
      return;
    }
    debug(`heartbeat failed: ${err.message}`);
  }
}

async function release() {
  if (state.sessionId === null) return;
  const id = state.sessionId;
  state.sessionId = null;
  clearInterval(state.heartbeat);
  try {
    const r = await api('POST', '/api/session/release', { sessionId: id });
    log(`released ${opts.page}${r.leasesReleased ? ` (+${r.leasesReleased.length} leases)` : ''}`);
  } catch (err) {
    debug(`release failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// acting on one comment
// ---------------------------------------------------------------------------

async function act(comment) {
  const ref = shortRef(comment.id);
  const blockId = comment.anchor?.blockId ?? null;

  // RESERVE the block for the read-and-compose, then hand it back BEFORE
  // writing. This ordering looks wrong and is not: no write endpoint accepts a
  // sessionId, so /api/edit takes a lease of its own and collides with the one
  // we are holding — a held lease refuses OUR OWN write with 409 blocks-leased,
  // naming our own leaseId. Verified against the merged runner; see "Lease the
  // blocks — around the READ, not the write" in the contract.
  let lease = null;
  if (blockId !== null) {
    try {
      lease = await api('POST', '/api/lease', {
        page: opts.page, blocks: [blockId], sessionId: state.sessionId, ttlMs: 30_000,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone else holds it. Move on — never retry in a tight loop, and
        // re-evaluate rather than applying stale intent when we come back.
        log(`${ref}: ${blockId} is held (${err.reason}) — will come back to it`);
        scheduleRetry();
        return;
      }
      throw err;
    }
  }

  let verdict;
  try {
    // Read at WRITE time, not at triage time: anything could have changed
    // between the two, including our own earlier edit in this pass. And read
    // from `source`, never from blocks[].text — that index is truncated plain
    // text, and an edit built from it strips inline markup silently.
    const doc = await api('GET', `/api/source${q(opts.page)}`);
    const inner = blockId === null ? null : blockInner(doc.source, blockId);
    verdict = decide(comment, inner);
  } finally {
    await dropLease(lease);
    lease = null;
  }

  if (verdict.kind === 'skip') {
    debug(`${ref}: skipped — ${verdict.why}`);
    return;
  }

  if (verdict.kind === 'edit') {
    if (blockId === null) {
      log(`${ref}: wants an edit but has no blockId to write to — replying instead`);
      await reply(comment, 'This comment is not anchored to a block, so I cannot edit it. '
        + 'Re-anchor it and I will pick it up.');
      return;
    }

    try {
      // The write is itself atomic: the endpoint holds the block for its own
      // duration. The only unprotected moment is between dropLease() above and
      // this call — lose that race and we get a 409 and re-read next bump,
      // which is the honest cost of the current design.
      const run = await api('POST', '/api/edit', {
        page: opts.page, blockId, newInner: verdict.newInner, ...actor,
      });
      if (run.pendingConfirmation === true) {
        // The scope gate. Nothing was written and the blocks stay HELD until
        // someone answers, so never walk away from one. A watcher declines its
        // own over-broad write; allowing is for when the human already said so.
        log(`${ref}: paused by the scope gate — ${run.scope?.summary ?? 'wider than the section'}; declining`);
        await api('POST', '/api/run/confirm', { page: opts.page, runId: run.runId, allow: false });
        await reply(comment, 'That edit reached wider than the section this comment is anchored to, '
          + 'so I declined my own write. Say explicitly if you want a change that wide.');
        return;
      }
      log(`${ref}: edited ${blockId} (run ${run.runId})`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        log(`${ref}: write refused (${err.reason}) — leaving it open`);
        scheduleRetry();
        return;
      }
      if (err instanceof ApiError && err.status === 422) {
        log(`${ref}: the runner rejected the edit (${err.body.code}) — nothing was written`);
        await reply(comment, `I could not apply that edit: ${err.body.code}. Leaving it open.`);
        return;
      }
      throw err;
    }
  }

  // Say what changed. A status flip on its own tells the author nothing.
  if (verdict.explainer && opts.quiet) {
    debug(`${ref}: not actionable by this process — quiet, leaving it for the session`);
    return;
  }
  await reply(comment, verdict.reply);
  if (verdict.status) {
    const updated = await api('POST', `/api/comment/${encodeURIComponent(comment.id)}/status`,
      { page: opts.page, status: verdict.status, ...actor });
    state.actedRev.set(comment.id, updated.rev ?? state.actedRev.get(comment.id) ?? 0);
  }
}

async function dropLease(lease) {
  if (lease === null) return;
  try {
    await api('DELETE', `/api/lease/${encodeURIComponent(lease.leaseId)}`
      + `?sessionId=${encodeURIComponent(state.sessionId ?? '')}`);
  } catch (err) {
    // 404 means it already expired — no protection was in force, which the
    // caller should assume anyway before writing.
    debug(`lease release: ${err.message}`);
  }
}

async function reply(comment, body) {
  const updated = await api('POST', `/api/comment/${encodeURIComponent(comment.id)}/reply`,
    { page: opts.page, body, ...actor });
  // Record the rev OUR write landed at, so our own reply does not read as new
  // work on the next bump — and so the author's next reply, which lands at a
  // higher rev, does.
  state.actedRev.set(comment.id, updated.rev ?? 0);
}

// ---------------------------------------------------------------------------
// triage
// ---------------------------------------------------------------------------

// A 409 is the ONE case a bump-driven watcher cannot recover from on its own:
// contention is not a sidecar change, so releasing the block wakes nobody, and
// the comment would sit untouched until something unrelated happened to bump
// rev. One delayed re-triage — past the 30 s default lease TTL — closes that
// hole without turning a refusal into a poll. Never retry in a tight loop: the
// human waits rather than preempting, and hammering a held block is how a
// watcher becomes the reason a paragraph stays locked.
const RETRY_MS = 35_000;
let retryTimer = null;

function scheduleRetry() {
  if (retryTimer !== null || state.stopping) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    debug('re-triaging after contention');
    pass().catch((err) => debug(`retry failed: ${err.message}`));
  }, RETRY_MS);
  retryTimer.unref?.();
}

// status open AND aiEdits !== false. Not `=== true`: the field is stored only
// when it is false, so absence means "in the batch".
const actionable = (c) => c.status === 'open' && c.aiEdits !== false;

async function pass() {
  const [{ comments, runs }, status] = await Promise.all([
    // #235: pass our sessionId so this read advances the author-visible "caught
    // up" receipt — a watcher's poll is exactly what "the watcher has seen it"
    // should mean. Empty when unclaimed, which the runner treats as no receipt.
    api('GET', `/api/comments${q(opts.page)}&sessionId=${encodeURIComponent(state.sessionId ?? '')}`),
    api('GET', `/api/status${q(opts.page)}`),
  ]);

  // HOLD gates intake. The runner reports it and does not enforce it — a write
  // during hold is accepted — so this check is the only thing that stops.
  if (status.hold?.on === true) {
    debug(`hold is on since ${status.hold.since} (${status.hold.heldCount} queued) — not taking new work`);
    return;
  }

  // Your own writes bump rev and wake your own stream. Read `lane` and `actor`
  // before concluding someone else edited the document: a session-authored run
  // is lane 'proposed' | 'direct-edit' with model null and cost nothing.
  const last = runs.length > 0 ? runs[runs.length - 1] : null;
  if (last && opts.verbose) {
    const mine = last.actor?.agentName === opts.agentName;
    debug(`last run ${last.runId} lane=${last.lane} by=${last.actor?.agentName ?? 'human'}`
      + `${mine ? ' (mine — not a second writer)' : ''}`);
  }

  const work = comments.filter((c) => actionable(c)
    && (c.rev ?? 0) > (state.actedRev.get(c.id) ?? -1));

  if (work.length === 0) {
    debug('nothing actionable');            // say nothing when there is nothing
    return;
  }

  // Several comments on ONE block become one unit of work: applied one at a
  // time, the second is written against text the first just changed. This
  // reference handles them one per pass and re-reads the source each time,
  // which is the cheap version of the same guarantee — a real agent should
  // merge them into a single edit.
  const byBlock = new Map();
  for (const c of work) {
    const key = c.anchor?.blockId ?? '(unanchored)';
    if (!byBlock.has(key)) byBlock.set(key, []);
    byBlock.get(key).push(c);
  }

  for (const [block, group] of byBlock) {
    if (group.length > 1) {
      log(`${group.length} comments on ${block} (${group.map((c) => shortRef(c.id)).join(', ')}) `
        + '— handling them one at a time, re-reading between each');
    }
    for (const c of group) {
      // Notes are CONTEXT: read for the block, never actioned. They are already
      // filtered out by actionable(); this is where a real agent would fold the
      // block's notes into the prompt it writes from.
      try {
        await act(c);
      } catch (err) {
        log(`${shortRef(c.id)}: failed — ${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// the event stream
// ---------------------------------------------------------------------------
//
// SSE over plain fetch: `event: <name>` + `data: <json>`, frames separated by a
// blank line, `: ping` keep-alives every 20 s. The stream carries {rev} and
// nothing else — state, not a delta — so a dropped frame is self-healing and a
// reconnect is just a refetch.

async function* frames(signal) {
  const res = await fetch(`${opts.runner}/api/events${q(opts.page)}`, { signal });
  if (!res.ok || res.body === null) throw new Error(`/api/events: HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (raw.startsWith(':')) continue;                       // keep-alive
      let event = 'message';
      let data = null;
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) {
          try { data = JSON.parse(line.slice(6)); } catch { data = null; }
        }
      }
      yield { event, data };
    }
  }
}

async function watch() {
  let backoff = 1000;
  while (!state.stopping) {
    const ctl = new AbortController();
    const onStop = () => ctl.abort();
    process.once('SIGINT', onStop);
    try {
      for await (const { event, data } of frames(ctl.signal)) {
        backoff = 1000;                                        // a frame = healthy
        if (event === 'hello') { debug(`stream open at rev ${data?.rev}`); continue; }
        if (event !== 'rev') continue;
        debug(`rev ${data?.rev}`);
        await pass();
      }
    } catch (err) {
      if (state.stopping) break;
      debug(`stream dropped: ${err.message}`);
    } finally {
      process.removeListener('SIGINT', onStop);
    }
    if (state.stopping) break;
    // The runner may be restarting. Back off, then reconnect and refetch — no
    // state is lost, because the next pass reads current state.
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 15_000);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const info = await api('GET', '/api/info');
  log(`runner ${info.version} on ${opts.runner}, serving ${info.root}`);

  const doc = await api('GET', `/api/source${q(opts.page)}`);
  if (doc.blocks.length === 0) {
    // No data-rev ids: nothing to anchor to, nothing to lease. Stamping is
    // idempotent, so this is safe to call on a page that turns out to be fine.
    log(`${opts.page} is unstamped — instrumenting`);
    await api('POST', '/api/instrument', { page: opts.page });
  }

  await claim();

  const { comments } = await api('GET',
    `/api/comments${q(opts.page)}&sessionId=${encodeURIComponent(state.sessionId ?? '')}`);
  const pre = comments.filter(actionable);
  if (opts.catchUp) {
    log(`catching up on ${pre.length} pre-existing actionable comment(s)`);
  } else {
    // Baseline them and SAY SO. A watcher that silently ignores what was
    // already on the page leaves its author waiting for work it never took.
    for (const c of comments) state.actedRev.set(c.id, c.rev ?? 0);
    log(`${comments.length} existing comment(s), ${pre.length} of them actionable — `
      + `NOT actioning those (pass --catch-up to include them)`);
  }

  const status = await api('GET', `/api/status${q(opts.page)}`);
  if (status.hold?.on === true) {
    // Hold survives across sessions, so a watcher attaching to a held page must
    // announce it rather than sit silent while its author wonders why.
    log(`hold is ON (since ${status.hold.since}, ${status.hold.heldCount} queued) — `
      + 'taking no new work until it is released');
  }

  log('watching. cmd-c to stop.');
  await watch();
}

const shutdown = async () => {
  if (state.stopping) return;
  state.stopping = true;
  await release();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(async (err) => {
  console.error(`[watch] ${err.message}`);
  await release();
  process.exit(1);
});

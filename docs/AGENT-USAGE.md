# Agent usage — Redline from Claude Code, a terminal agent, or a script

Three ways in, one runner behind all of them. The wire contract is
`docs/AGENT-CONTRACT.md`; this page is the worked examples.

The runner is the only writer of the document and the sidecar. An agent reads,
comments, and proposes; the runner validates, applies, snapshots, and records.

## 1. Any MCP client (Claude Code, Gemini CLI, Copilot CLI, …)

Register the server once:

```sh
redline install-mcp --client claude     # ./.mcp.json          (--global → ~/.claude.json)
redline install-mcp --client gemini     # ./.gemini/settings.json
redline install-mcp --client copilot    # ~/.copilot/mcp-config.json
```

`--dry-run` prints the exact file and the exact JSON without writing;
`--force` replaces a differing entry; `--uninstall` removes ours and leaves
everyone else's alone. It merges — your other MCP servers survive untouched.

**Copilot CLI has no project-scoped config**, so `--project` there is an error
rather than a silent write to the per-user file. Set `COPILOT_HOME` to move it.

**MCP registration is generic.** Any MCP client can talk to the server; these
three are presets, not the limit of what works. To wire up anything else, write
the same entry by hand into whatever config that client reads:

```json
{
  "mcpServers": {
    "redline": {
      "command": "node",
      "args": ["/path/to/redline/runner/mcp-server.mjs"],
      "env": { "REDLINE_AGENT_NAME": "claude-code" }
    }
  }
}
```

Then ask for the work in plain language — the tools do the rest:

> Read `docs/plan.html` with redline, comment on anything that buries the ask,
> and revise the first one.

### The intended loop

The one this is built for, and it is human-orchestrated at both ends — you say
when to open it, and you say when you are done. Nothing blocks:

1. **"Write me a plan and open it in redline."** The agent writes the file,
   calls `redline_instrument` to stamp it, and hands back the `url`.
2. **You comment in the browser.** Mark a comment as a note rather than an
   AI-edit if you do not want Send All touching it.
3. **"Read my comments and action them."** The agent calls
   `redline_list_comments`, applies its own edits via `redline_propose_edits`,
   replies on each thread with `redline_reply`, and sets statuses with
   `redline_update_status`.

### The thirteen tools

| Tool | What it does |
|---|---|
| `redline_read_source` | raw source + the `data-rev` block index (`blocksOnly: true` for just the index) |
| `redline_instrument` | stamp `data-rev` ids on a page you just created — without this it has no blocks and cannot be commented on |
| `redline_list_comments` | every comment: body, status, anchor, replies, resolution, `aiEdits` |
| `redline_add_comment` | add a comment anchored to a block — a note unless you pass `aiEdits: true` |
| `redline_reply` | reply on a comment thread — say what you changed, rather than only flipping a status. Replies render in a narrow (~320px) card: be brief, lead with the answer, cite a path/block id/run id instead of pasting detail, and never use tables (they do not fit; lists and code blocks do) |
| `redline_run_revision` | run the runner's revise loop over one comment or a batch — **the only tool that spends money, and off-limits to a watching session** |
| `redline_propose_edits` | validate your own edits (dry run), then apply them — free, and one undo unit however many blocks |
| `redline_direct_edit` | replace ONE block's inner — free, the short form of the above |
| `redline_confirm_scope` | answer a scope-gate pause your write triggered |
| `redline_update_status` | reopen or set a decision status (addressed/declined/deferred) — `resolved` is human-only, the runner refuses it from an agent (#250) |
| `redline_run_status` | runs, leases, presence, hold, and the last run |
| `redline_set_ai_edits` | mark a comment as an edit request or a note |
| `redline_undo` | revert an applied run — **pass `expectRunId`, see below** |

Every result carries a `url` you can hand to a human to open in the browser.

> **Do not cite comment ids in conversation.** `c-5999e7a0980f` cannot be read
> aloud, remembered, or matched to a card. The overlay shows a four-character
> handle beside each comment (`user · k7mq`), derived from the id so you can
> compute the same one — see `docs/AGENT-CONTRACT.md`. Use the id in tool
> arguments, the handle whenever you talk to a person.

> **You do not need an API key to edit.** `redline_propose_edits` and
> `redline_direct_edit` apply YOUR prose through the runner's writer with no
> model call. `redline_run_revision` is the paid lane, for when you want the
> runner's model to do the writing instead.

### When a write pauses

A write that reaches past the section its comment is anchored to, or changes the
page theme, comes back as `{ pendingConfirmation: true, runId, scope }` instead
of applying. Nothing was written, and the blocks stay held until someone
answers.

Answer with `redline_confirm_scope { file, runId, allow }`. Prefer declining
your own over-broad write to leaving it pending — a pause holds blocks. Only
allow when the human has already told you to make a change that wide; the
author's surface for this is the document, not your chat.

If you know up front that a sweep is what was asked for, pass
`scope: { requiresConfirmation: false, summary: "You asked for every header." }`
so it applies with your intent on the record rather than reading as an accident.

### Sessions, leases and hold — collaborating live

For a one-shot pass — read comments, edit, reply, done — none of this applies.
It is for a session that stays attached to a document while its author works.

**`docs/AGENT-CONTRACT.md` → "Watch and collaborate — the protocol" is the
normative version of this**; `examples/watch-collaborate.mjs` is a runnable
reference watcher, and `skills/redline-watch/SKILL.md` wraps it for Claude
Code. The short form:

- `POST /api/session/claim` says a session is watching this page; a `409` names
  who already has it. Claims expire, so something must heartbeat on a timer and
  die with your session.
- `POST /api/lease` holds blocks across several calls. Reserve them around the
  READ, then RELEASE before writing: no write endpoint accepts a `sessionId`, so
  a lease you are holding refuses your own write with `409 blocks-leased`.
- `hold` on `redline_run_status` means the author is queueing comments to hand
  over as a set. While it is on, do not action new ones. The runner reports hold
  and does not enforce it.

**A watching session never calls `redline_run_revision`.** That is the paid
OpenRouter lane and it belongs to the human pressing Send. Watcher mode is
`redline_direct_edit` and `redline_propose_edits` — free, and measured better,
because the session has read the whole document.

There are no MCP tools for session, lease or hold yet — they are HTTP, and the
watch loop cannot be a tool at all because MCP is request/response with no
subscribe primitive.

> **Always pass `expectRunId` to `redline_undo`.** Without it, undo is
> last-run-wins: it reverts whichever run is on top, *including one a human
> made after yours*, and reports success. With it, the runner refuses with 409
> and tells you which run is actually on top. The id comes back from
> `redline_run_revision` and `redline_propose_edits`, or from
> `redline_run_status`.

### Edit requests and notes

Every comment carries `aiEdits`. `true` means the author wants the text
**changed**; `false` means it is a **note** — a question, an observation, or
something to leave alone. Respect it: do not edit a block on the strength of a
note. `redline_list_comments` states it explicitly on every comment and reports
`noteCount` alongside `count`.

Comments **you** create default to `aiEdits: false`. Send-All is what the human
pays for, and an unflagged comment is in that batch — so your observations stay
out of it until someone flags them in. Nothing you note in passing becomes a
paid revision by default.

Pass `aiEdits: true` on `redline_add_comment` when you do mean the text to
change. Setting it at creation matters: a comment is born with its audience, so
a watcher can never see it briefly as the other kind.

Use `redline_set_ai_edits` to promote one of your notes into a real edit
request, or to mark a comment as handled after you edited the block yourself.
It is separate from `redline_update_status` on purpose: a comment's status and
whether a batch picks it up move independently.

The runner enforces this, not just the browser. A **batch** run
(`redline_run_revision` with `commentIds`) drops comments marked as notes and
returns the dropped ids in `skipped`; a batch of nothing but notes is refused
with 400 before any model is called. A **single-comment** run is never
filtered — naming one comment is a deliberate act on that comment.

A typical sequence inside one session:

```jsonc
redline_read_source   { "file": "docs/plan.html", "blocksOnly": true }
redline_add_comment   { "file": "docs/plan.html", "blockId": "r-1a2b",
                        "quote": "We should probably consider",
                        "body": "Hedged. State the recommendation." }
redline_run_revision  { "file": "docs/plan.html", "commentId": "c-…" }
redline_run_status    { "file": "docs/plan.html" }
```

Or edit it yourself, letting the runner be the writer:

```jsonc
redline_propose_edits { "file": "docs/plan.html",
                        "edits": [{ "blockId": "r-1a2b", "newInner": "Ship it in Q3." }] }
// → { "valid": true, "changed": true, … }   nothing written yet
redline_propose_edits { "file": "docs/plan.html", "dryRun": false, "commentId": "c-…",
                        "decisions": [{ "id": "c-…", "decision": "addressed",
                                        "summary": "Stated the recommendation." }],
                        "edits": [{ "blockId": "r-1a2b", "newInner": "Ship it in Q3." }] }
// → the run record; the document is written, snapshotted and undoable
```

There is no MCP tool that writes a file. If a proposal is rejected you get the
reason (`unknown-block`, `unbalanced`, `data-rev-tampered`, …) and the document
is untouched — fix the proposal and send it again.

## 2. Terminal agents and scripts (CLI)

```bash
redline list docs/plan.html
redline source docs/plan.html --blocks
redline source docs/plan.html > /tmp/plan-copy.html     # byte-exact

redline comment docs/plan.html \
  --block-id r-1a2b --quote "We should probably consider" \
  --body "Hedged. State the recommendation."

redline edit docs/plan.html --block-id r-1a2b --inner "Ship it in Q3."

redline run docs/plan.html --comment-id c-4f2c9a1b7e30
redline status docs/plan.html
redline set-status docs/plan.html --comment-id c-4f2c9a1b7e30 --status open
```

`redline edit` replaces one block and costs nothing; `redline run` calls the
model.

Build `--inner` from the full document (`redline source <page>`), never from the
block index `redline source --blocks` prints: that text is truncated plain text,
so an `--inner` built from it silently strips inline markup and cuts long blocks
short.

Proposing edits from a file (or stdin):

```bash
cat > /tmp/edits.json <<'JSON'
{
  "decisions": [{ "id": "c-4f2c9a1b7e30", "decision": "addressed", "summary": "De-hedged." }],
  "edits": [{ "blockId": "r-1a2b", "newInner": "Ship it in Q3." }]
}
JSON

redline propose docs/plan.html --edits-file /tmp/edits.json            # dry run
redline propose docs/plan.html --comment-id c-4f2c9a1b7e30 \
                               --edits-file /tmp/edits.json --apply    # write

jq -n '{edits:[{blockId:"r-1a2b",newInner:"Ship it in Q3."}]}' \
  | redline propose docs/plan.html --edits-file -
```

Add `--json` to any command to get the runner's answer verbatim, including
error bodies — that is the form to parse.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | success (a dry run that came back **valid** is a success) |
| 1 | usage error — unknown command, missing or malformed flags |
| 2 | could not reach or start a runner |
| 3 | the runner refused the request (any 4xx/5xx) |
| 4 | a dry-run proposal came back **invalid** |

So a scripted loop reads naturally:

```bash
if redline propose "$DOC" --edits-file "$EDITS"; then
  redline propose "$DOC" --edits-file "$EDITS" --apply --json
else
  echo "proposal rejected — re-read the block and try again" >&2
fi
```

## 3. Raw HTTP

Anything that speaks HTTP can drive the same endpoints:

```bash
BASE=http://127.0.0.1:5175

curl -s "$BASE/api/source?page=docs/plan.html" | jq '.blocks'

curl -s -X POST "$BASE/api/comment" -H 'content-type: application/json' -d '{
  "page": "docs/plan.html",
  "body": "Hedged. State the recommendation.",
  "anchor": { "blockId": "r-1a2b", "quote": "We should probably consider" },
  "creator": "agent", "agentName": "my-script"
}'

curl -s -X POST "$BASE/api/run" -H 'content-type: application/json' \
  -d '{"page":"docs/plan.html","commentId":"c-4f2c9a1b7e30"}'
```

Full endpoint reference: `docs/AGENT-CONTRACT.md`.

## Finding the runner

Both the MCP server and the CLI look for a runner before every session:

1. walk up from the document's directory to the nearest `.redline.lock`;
2. check the pid is alive, `/health` answers, and `/api/info` reports that same
   directory as its root;
3. if nothing is serving it, start a runner on an ephemeral port.

A runner the agent started is stopped when the session ends. A runner that was
already there — the author's browser session — is never stopped.

| Setting | Effect |
|---|---|
| `--runner <url>` / `REDLINE_RUNNER_URL` | talk to exactly this runner; skip discovery |
| `--dir <dir>` | the served root, when `<page>` is a page id rather than a path |
| `--no-auto-start` / `REDLINE_NO_AUTO_START=1` | never spawn; fail with the manual command |
| `--agent-name` / `REDLINE_AGENT_NAME` | the name recorded on this session's actions |

To run the runner yourself instead:

```bash
node runner/index.mjs docs/          # http://127.0.0.1:5175/
```

## What an agent cannot do

- Write the document or the sidecar directly. There is no HTTP method that
  uploads a file; the static server answers `405` to anything but GET/HEAD.
- Slip past validation. Every write goes through `applyEdits`: tag balance,
  the ASCII/entities invariant, and the `data-rev` marks are checked on each
  op and over the whole document, all-or-nothing.
- Invent block ids. New blocks are inserted with `{afterBlockId|beforeBlockId,
  html}` and the runner mints the id.
- Read secrets. `redline.config.json` is never served, and runner errors are
  fixed strings — never the API key, never an upstream response body.
- Act anonymously. Comments, replies, status changes, and applied proposals all
  record `creator: "agent"` and the agent name.

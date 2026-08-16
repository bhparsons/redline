# Redline — review layer for static HTML

Redline reviews and revises static HTML documents with an agent you choose.
You comment on the rendered page; the agent returns structured edits; a local
runner applies them via targeted string surgery and validates every change.
The result is a sidecar `runs[]` log, a receipt for every change, including
the comment that caused it, the model, the cost, the outcome, and the runs
you declined or that timed out. Git is optional; the runner keeps its own
`.history/` snapshots and undo stack.

---

## Getting started

### What you need

- **Node 20 or newer.** The runner has zero dependencies and never needs
  `npm install`.
- **Chrome.** The review overlay is a Chrome extension, loaded unpacked.
- **An agent to do the revising.** Either an agent session you already pay for
  (Claude Code and other MCP clients — the default, no API key), or an
  OpenRouter key if you would rather Redline call a model directly. See
  [Choose your lane](#choose-your-lane) below; you can start without either and
  just take notes.

### Install

**Clone it — you need the repo anyway for the extension:**

```sh
git clone https://github.com/bhparsons/redline
cd redline
node bin/redline.mjs demo          # seeds a sample document and opens it
```

**Get the short `redline` command** (optional, one line, do it once):

```sh
npm link            # inside the clone; now `redline` works from any directory
```

Without this, every `redline …` below is `node bin/redline.mjs …` run from
inside the clone. Both are the same program — `redline` is just a shortcut,
and cloning does not create it.

That is the whole install, and it is the only one. **Clone it** — the review
overlay is a Chrome extension you load from a folder on disk, and you cannot
load a folder you do not have.

Then load the extension (next section) and point Redline at your own document:

```sh
redline path/to/doc.html      # serves that file's directory and opens the page
redline serve <dir>           # or serve a whole directory
```

`redline <file>` reuses a runner already serving that directory rather than
starting a second one, and picks a free port the extension knows to look on.
Add `--no-open` to print the URL instead of launching a browser.

The runner binds `127.0.0.1` only. Default port 5175, walking upward to 5184
if that is taken (`--port N` or `REDLINE_PORT` to pin one). If all ten are
busy — and on a machine running a lot of local services they can be — it takes
any free port the operating system offers rather than refusing to start. A
document served on any port works normally; the extension talks to whichever
address served the page.

### Choose your lane

Redline does not write your document. An agent does, and you pick which one.
There are two lanes and they never blend — no automatic fallback from one to
the other, because one costs money per run and the other does not.

**The watcher lane — an agent session you already pay for. No API key.**

You already have Claude Code (or another MCP client) on a subscription. Point
it at Redline and it reads your comments, does the work, and sends edits back
through the runner:

```sh
redline install-mcp --client claude     # writes ./.mcp.json
```

Then, in that session: *"Read `docs/plan.html` with redline, and revise the
open comments."* Cost per revision: nothing beyond the subscription you have.
This is the lane to start on.

**The OpenRouter lane — Redline calls a model itself. Your key, your spend.**

Useful when you want revisions to happen without a session open — from the
overlay's Send button, or overnight. You supply an OpenRouter key at first run
(or `OPENROUTER_API_KEY` in the environment), and every run bills you. Each
run's real cost is recorded on the run and shown in the overlay.

**Neither, at first.** Without an agent, everything except revision still
works: comment, reply, set statuses, edit text directly, undo. Nothing is sent
anywhere.

### First-run onboarding

The first time you point the runner at a directory with no
`redline.config.json` (and stdin is a terminal), it asks four things:

1. a style guide / CSS-conventions file to include in every revise prompt
   (optional, stored under `projectContext`),
2. preferred models per archetype (press Enter to accept each default),
3. an OpenRouter API key — **press Enter to skip this** if you are on the
   watcher lane; it is only for the OpenRouter lane,
4. an OTLP telemetry endpoint (optional; telemetry stays off without one).

Answers are written to `<your-docs-dir>/redline.config.json` and the server
starts. Pass `--no-onboarding` to skip, or create the config file yourself.

The runner does not require git. Undo uses `.history/` snapshots; git is an
opt-in export for people who want PRs.

### Load the extension

The v1 extension is unpacked-only. A Chrome Web Store listing is a later
milestone.

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and select this repo's `extension/` directory.
3. Browse to a page served by the runner
   (`http://127.0.0.1:5175/<page>.html`).
4. For `file://` pages, also enable "Allow access to file URLs" for the
   extension.

After pulling updates, reload the extension at `chrome://extensions`, then
refresh open tabs. Content scripts do not hot-swap on a page refresh.

### Reviewing a document

1. Open an HTML file served by the runner in Chrome.
2. Click the Redline toolbar icon to activate the overlay.
3. Select text and comment. Mark a comment as a **note** if you do not want
   Send All touching it.
4. Click **Send All** to run the agent on every open edit-request comment, or
   run a single comment.
5. The agent returns structured edits. The runner applies them, validates
   tag balance and entity encoding, and snapshots the prior version.
6. Approve or decline in the overlay. Declines and timeouts are recorded too.
7. **Undo** reverts the last successful run (or a specific run by id).
8. Open the receipts report with `node report.mjs <page>` to turn the session
   into a single HTML file you can send back.

### Sharing a review with someone else, or with another agent session

Your comments are not locked inside the browser. They live in a plain JSON file
called the **sidecar**, sitting next to the document with the same name plus
`.review.json` — comment on `plan.html` and you get `plan.html.review.json`.
That file holds every comment, reply, status and run record.

There are three ways to hand a review to someone:

- **Send them the file.** Copy `<page>.html.review.json` alongside the document
  and the other person sees exactly what you see. Nothing else is needed.
- **Point another agent at it.** Any agent with a terminal can read the review
  through the CLI — `redline list <page>` prints every comment, and
  `redline list <page> --json` gives it as data. The agent does not have to be
  the one that was in the room. `docs/AGENT-CONTRACT.md` is the full contract.
- **Send a report to someone who has no tooling.** `node report.mjs <page>`
  writes one self-contained HTML file — every comment, how it was resolved with
  before-and-after text, and the run history. Inline CSS, no scripts, safe to
  email. It reads the sidecar and changes nothing.

The document itself stays clean: comments are never written into your HTML, so
the file you publish is the file you wrote.

### What gets sent to the agent

**On the watcher lane, nothing leaves your machine.** The agent session reads
the document through the local runner and writes edits back through it.

**On the OpenRouter lane,** every revise run sends the full page source to
OpenRouter. That is by design: the agent needs to see the document to edit it.
The prompt also carries:

- the revise contract (cached across runs),
- the anchored block's HTML,
- the comment body, replies, and prior decisions,
- context packs — the editing rules for the run, see [Skills](#skills),
- any `projectContext` files listed in `redline.config.json` (paths relative
  to the served root; missing or dotfile paths are skipped and logged).

The security boundary is the served root. The runner only reads files inside
the directory you point it at. Project context files must be inside that root
and pass traversal and dotfile guards. `redline.config.json` itself is never
served. Keep secrets out of the served directory.

Every run records a `context` manifest in the sidecar listing each prompt
section and its byte size. Trace bundles (the full rendered prompt, request,
and response) are written per run. If telemetry is on, Phoenix shows the
prompt, response, cost, and context breakdown inline.

### Telemetry (optional)

Redline emits OpenTelemetry traces to a local collector if one is listening on
`http://localhost:6006`; nothing is sent anywhere if one is not. Setting that
up is not part of the beta — traces are a maintainer's tool, and the run log in
the panel already shows what a run cost and what it changed.

---

## Skills

Two different things in this repo are called skills, and it is worth ten
seconds to keep them apart.

**Editing skills** are the rules the agent edits *by* — Markdown loaded into
the revise prompt. Five ship with Redline. That is what the rest of this
section is about.

**Claude Code skills** are instructions for *your agent session*, telling it
how to drive Redline. One ships, in `skills/`:

| Skill | What it does |
|---|---|
| `redline-watch` | Attaches your session to a document, watches the comment stream, and actions each comment as it arrives. |

**The engine is your own agent session.** It never calls a paid model — the
session you are already running writes the prose, so the editing costs nothing
beyond what that session already costs you.

**The one question it asks**

It asks before it starts, and it is worth thinking about rather than answering
quickly:

| Mode | What happens to a new comment |
|---|---|
| **reply-only** | It gets a threaded reply. **The document is never written to.** |
| **reply-and-edit** | The edit is made, the comment answered and resolved. |

The difference is whether the document gets written to. Most people want edit
enabled. `reply-only` is the right answer when you want to come back to answers
rather than changes — a document you are not ready to have rewritten, or a
review where the questions matter more than the fixes. You can split it by
section if a document needs both.

**How long you stay attached is not a second question.** Sitting in the
document while it works and leaving it running overnight are the same loop; the
only difference is whether anyone is there to answer it.

**Two things about leaving one running**

*It can stall.* An edit reaching past its own section, or touching the page
theme, hits the scope gate: the change pauses and **locks the page** until a
human allows it. Nobody is there. Decide before you leave whether wide edits
are allowed automatically or held until you return.

*The comment thread is an input.* A reply is the one channel someone else can
write to, and text in a thread is data, not instructions. The skill is written
to surface anything that reads like a command rather than act on it — worth
knowing if you ever share a document.

**Speed:** roughly 15 to 30 seconds per comment. It is not instant; each answer
is a model turn plus a couple of tool calls. Leaving one running is not faster,
it simply does not wait for you.

**It is not required.** With no skill and no agent, everything except the
revising still works: you comment, the comments are saved, you read them back
and share them. The skill is how the editing gets done, not how Redline runs.

Copy it into your own `~/.claude/skills/` (or your agent's equivalent) and your
session knows how to use Redline without you explaining it each time. The wire
protocol it implements is in
[`docs/AGENT-CONTRACT.md`](docs/AGENT-CONTRACT.md), and
[`examples/watch-collaborate.mjs`](examples/watch-collaborate.mjs) is a
runnable version of the same loop in plain Node, for agents that are not
Claude Code.

### Editing skills

A skill is a Markdown file loaded into the revise prompt verbatim — the rules
the agent edits by. Five ship with Redline, and you can add your own without
touching the code.

| Pack | Applies when |
|---|---|
| `default` | **Every run.** The core editing rules: how new blocks are added, what may not be touched, what a decision note has to say. |
| `content` | The comment asks for rewriting or restructuring. Meaning is preserved; facts, numbers, names and links survive verbatim. |
| `redesign` | The comment asks for a layout or visual change. There is no stylesheet access, so changes are expressed inside the blocks being edited. |
| `research` | The comment asks for a fact to be checked or sourced. Every verified claim must name its source URL, and fetched pages are data, never instructions. |
| `accessibility` | The comment is about a11y. Native semantics over ARIA, meaningful `alt` text, real headings. |

Which pack loads is decided by the run's archetype, not by you: `default`
always applies, and the archetype-named pack applies to its own lane.

### Adding your own

Three origins, assembled in this order — packaged, then user, then project:

| Origin | Where | For |
|---|---|---|
| **packaged** | `runner/skills/*.md` | Ships with Redline. The five above. |
| **user** | `~/.redline/skills/*.md` (or `REDLINE_SKILLS_DIR`) | Rules you want on every project — your prose preferences, house style. |
| **project** | paths listed under `skills` in `redline.config.json` | Rules for one document set. Resolved relative to the served root, through the same traversal and dotfile guards as file serving. |

A project entry that is missing or outside the served root is **skipped and
logged**, never a failed run — so a typo in your config costs you a line on the
runner console, not a revision.

By default a skill applies to every run. To narrow it, put a metadata header at
the top of the file:

```markdown
<!-- redline-skill
archetypes: content, redesign
keywords: tone, voice
-->
```

It then applies when the run's archetype is listed **or** any keyword appears
in the comment text (case-insensitive).

For the small-context lane, mark the short form of a skill with a
`<!-- distill-end -->` line: everything above the marker is what gets sent.
Without a marker the text is truncated at a paragraph boundary. Distillation
never invents content.

No skill can override the editing invariants. Skills are prompt text; every
write still goes through the runner's validation before it touches your file.

## What to expect (and what not to)

Known limits worth reading before you file a bug:

- **The extension is unpacked-only.** Chrome will remind you about developer
  mode on every launch. A Web Store listing is a later milestone.
- **Reloading the page while the runner is down loses the page** — the runner
  is what serves it. Comments you have written are buffered in the browser and
  saved when the runner returns, but the tab itself will not survive a reload.
- **The docked panel narrows the page, not the browser window.** A document
  with window-width responsive rules (`@media`, `vw`) will not reflow when the
  panel opens. Container-based sizing works correctly.
- **A page whose own script writes into a stamped block** will have that
  content reverted on the next document re-sync. The file on disk is the truth
  Redline reviews — see
  [`docs/REVIEWING-INTERACTIVE-DOCS.md`](docs/REVIEWING-INTERACTIVE-DOCS.md).
- **Undo is linear** and backed by `.history/` snapshots, not git. Reverting a
  run that a later run built on top of is refused rather than guessed at.

## Something went wrong?

Open an issue on this repo. Four things make a report actionable, and three of
them are on screen already:

1. **What you did**, in one line.
2. **The runner version and the extension version.** Click the Redline icon in
   your toolbar — the popup shows both, side by side. Include both even if one
   looks irrelevant: a stale extension talking to a newer runner is the single
   most common cause of "it stopped working", and it is invisible unless you
   compare the two numbers.
3. **The run id**, if a revision was involved. It is on the run strip in the
   panel and in the run log.
4. **Whether the runner was up.** The panel says so.

If it did not work and you cannot say why — no error, nothing to copy — that is
still worth sending. Say what you expected and what happened instead.

## Reviewing interactive documents

Documents with tabs, accordions, decks, or toggles need two small event
listeners so the overlay can reveal hidden anchors and the host page can
disable its own hotkeys while Redline is active:

- `rv:reveal` (CustomEvent): dispatch on the element containing a hidden
  anchor so the overlay can scroll to it.
- `rv:modechange` (CustomEvent): fires when Redline enters or exits review
  mode; listen to disable your own keyboard shortcuts while active.

Most documents do not need these. They are integration hooks for doc authors
whose pages hide content behind interactions.

---

## Agents in the loop

External agents can read the document, comment, trigger revisions, and
propose edits. The runner stays the only writer. Every agent-facing write
lands in `runs[]` with provenance and cost.

**Important distinction:** agent-driven runs (MCP, CLI, HTTP) that trigger
the revise loop use the runner's OpenRouter key to call the model.
Agent-driven proposals (`redline propose`, `redline_propose_edits`) do not
call a model at all; the agent computes the edits itself and sends them
through the runner's validation and apply pipeline.

### MCP (Claude Code, Gemini CLI, Copilot CLI)

```sh
redline install-mcp --client claude     # ./.mcp.json
redline install-mcp --client gemini     # ./.gemini/settings.json
redline install-mcp --client copilot    # ~/.copilot/mcp-config.json
```

Then ask in plain language: "Read `docs/plan.html` with redline, comment on
anything that buries the ask, and revise the first one."

The ten MCP tools: `redline_read_source`, `redline_instrument`,
`redline_list_comments`, `redline_add_comment`, `redline_reply`,
`redline_run_revision`, `redline_propose_edits`, `redline_update_status`,
`redline_run_status`, `redline_set_ai_edits`, `redline_undo`.

Always pass `expectRunId` to `redline_undo`. Without it, undo reverts
whichever run is on top, including one a human made after yours.

### CLI

```sh
redline list docs/plan.html
redline source docs/plan.html --blocks
redline comment docs/plan.html --block-id r-1a2b --quote "..." --body "State the ask."
redline run docs/plan.html --comment-id c-...
redline propose docs/plan.html --edits-file edits.json --apply
redline status docs/plan.html
```

Add `--json` to any command for machine output. Exit codes: 0 success,
1 usage, 2 no runner, 3 runner refused, 4 invalid dry-run proposal.

### HTTP

```sh
curl -s "$BASE/api/source?page=docs/plan.html" | jq '.blocks'
curl -s -X POST "$BASE/api/run" -H 'content-type: application/json' \
  -d '{"page":"docs/plan.html","commentId":"c-..."}'
```

The CLI and MCP server find a runner from `.redline.lock` or start one on an
ephemeral port, and stop only what they started.

The full wire contract (endpoints, error shapes, limits, provenance) is in
[`docs/AGENT-CONTRACT.md`](docs/AGENT-CONTRACT.md).

Reviewing a page whose own script writes into its content? The file on disk
is the truth Redline reviews — see
[`docs/REVIEWING-INTERACTIVE-DOCS.md`](docs/REVIEWING-INTERACTIVE-DOCS.md)
for what that means for script-rendered blocks.

### What works offline

If the runner is down or not started, the overlay keeps working as a reader
and note-taker, and refuses what it cannot honour:

- **New comments and replies buffer.** They are held in this browser (per
  page, surviving a closed tab) and saved automatically when the runner comes
  back — comments first, then replies. A buffered item that cannot be saved
  (its text left the document, or its comment was deleted) stays on screen as
  a failed card with Copy text as the floor; nothing is silently dropped.
- **Text edits, AI runs, status changes, and undo refuse** with a note saying
  why: each writes to the document or sidecar, which only the runner can do,
  and replaying a document write later against a moved document is how work
  gets corrupted.

---

## Internal notes

The sections below are for maintaining the project, not for end users.

### Architecture

- **Local runner** (stdlib-only Node, zero dependencies): serves the
  document, runs the agent, applies structured edits, writes the sidecar,
  keeps `.history/` snapshots.
- **Chrome extension**: the review overlay. Comment, view the thread, approve
  or decline. Exposes `window.redline` (build tag, mode, version) and
  `data-rv-mode` on `<html>` for host pages to detect review mode.
- **Agent adapter**: OpenRouter by default. Classifies the comment archetype,
  picks the model and context pack, sends the prompt, receives structured
  edits.
- **All writes** are targeted block-inner string replacements on the raw
  source. Never DOM-reserialize. The agent never touches disk; the runner is
  the only writer.

### Decisions (Phase 12)

- **The watcher lane is the default (2026-08-13).** A new user drives Redline
  from an agent session they already pay for; no key, no per-run spend. The
  OpenRouter lane stays fully supported for revisions that must happen without
  a session open.
- **BYOK on the OpenRouter lane.** No bundled key, no proxy. Set
  `OPENROUTER_API_KEY` in the environment or `agent.apiKey` in
  `redline.config.json`, or answer the onboarding prompt.
- **Unpacked extension only for v1.** Chrome Web Store listing is a later
  milestone. Load from this repo's `extension/` directory.
- **Git is optional.** Undo uses `.history/` snapshots and a linear stack in
  the sidecar. Git is an opt-in export, not a dependency.
- **CLI-first release.** The runner and CLI are the primary distribution. The
  extension is loaded unpacked. A store listing follows after the CLI path is
  proven.

### Versioning

Both version numbers move on every commit that touches their tree. No
exceptions for small changes.

| Touched | Bump | Reported by |
|---|---|---|
| `extension/` | `extension/manifest.json` `version` and `version_name` | the popup's build tag |
| `runner/`, `bin/` | `package.json` `version` | `GET /api/info` and the popup's runner row |

After an extension change, reload at `chrome://extensions` then refresh open
tabs. After a runner change, restart the runner process.

### Packaging the extension (maintainer-only)

```sh
npm run package:extension
```

Zips `extension/` into `dist/redline-extension.zip` using the system `zip`
binary. `dist/` is gitignored. This is a convenience for manual install or
backup, not a store listing.

### Tests

```sh
node test.mjs                                      # the suite, ~3 s
node --test test/runner/store-ops.test.mjs         # one file
```

### Separate documents

- [`docs/AGENT-CONTRACT.md`](docs/AGENT-CONTRACT.md) — full wire contract:
  endpoints, error shapes, limits, provenance fields.
- Competitive analysis — separate future artifact, not yet written.

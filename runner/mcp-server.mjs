#!/usr/bin/env node
// runner/mcp-server.mjs — Redline as an MCP server.
//
//   node runner/mcp-server.mjs        (stdio; register as an MCP server named "redline")
//
// Speaks MCP over stdio: JSON-RPC 2.0, one message per line. The tools live in
// runner/lib/mcp-tools.mjs and are thin wrappers over the runner's HTTP API —
// this process never writes a document or a sidecar, so every trust rule stays
// in the runner where the browser and the CLI meet it too.
//
// A runner is discovered from the target document's directory (.redline.lock)
// or auto-started on an ephemeral port. One runner per served directory for
// the life of the session; auto-started ones are shut down when stdin closes,
// runners that were already there are left alone.
//
// Env:
//   REDLINE_AGENT_NAME     name recorded on this session's actions (default claude-code)
//   REDLINE_RUNNER_URL     talk to this runner instead of discovering one
//   REDLINE_NO_AUTO_START  never spawn a runner; fail with the manual command instead

import readline from 'node:readline';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS, callTool, closeAll, ParamError } from './lib/mcp-tools.mjs';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

function serverVersion() {
  try {
    return String(JSON.parse(readFileSync(path.join(SELF_DIR, '..', 'package.json'), 'utf8')).version ?? '0');
  } catch {
    return '0';
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handleToolsCall(id, params) {
  try {
    const result = await callTool(params?.name, params?.arguments ?? {});
    reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (err) {
    if (err instanceof ParamError) return replyError(id, -32602, err.message);
    // Runtime failure: an isError result, not a protocol error — the agent
    // should see the runner's message and decide what to do next.
    const detail = err.status ? `${err.message} (HTTP ${err.status})` : String(err.message ?? err);
    reply(id, { content: [{ type: 'text', text: detail }], isError: true });
  }
}

async function handleMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
    if (msg && !Array.isArray(msg) && msg.id !== undefined) replyError(msg.id, -32600, 'invalid request');
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification — no response

  if (method === 'initialize') {
    const pv = params?.protocolVersion;
    return reply(id, {
      protocolVersion: typeof pv === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(pv) ? pv : '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'redline', version: serverVersion() },
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') return handleToolsCall(id, params);
  return replyError(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return replyError(null, -32700, 'parse error');
  }
  handleMessage(msg).catch((err) => {
    if (msg?.id !== undefined && msg?.id !== null) replyError(msg.id, -32603, String(err.message ?? err));
  });
});

// End of session: stop every runner this process started (attached ones stay).
rl.on('close', async () => {
  await closeAll();
  process.exit(0);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await closeAll();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

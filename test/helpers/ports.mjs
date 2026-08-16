// test/helpers/ports.mjs — port allocation for tests that bind real servers (#240).
//
// The old approach asked the OS for an ephemeral port and then released it.
// On macOS the ephemeral range (49152+) is also where every OUTGOING connection
// gets bound, so under 15-way test parallelism a "free" window was routinely
// stolen between the check and the bind — a time-of-check-to-time-of-use race
// that made the suite non-deterministic whenever the machine was busy.
//
// Tests now draw from a reserved private range (20000-29999): below the
// ephemeral floor on both macOS (49152) and Linux (32768), and disjoint from
// the product's own 5175-5179 window, so a real runner on the machine can
// never collide with a test. Random placement keeps parallel workers apart;
// bindability is verified per port, and the one remaining (tiny) race window
// is closed by retrying the bind itself in startInWindow().

import net from 'node:net';

const RANGE_START = 20000;
const RANGE_SIZE = 10000;

/** True if nothing is listening on 127.0.0.1:port right now. */
export function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** A base port in the reserved range with `span` consecutive free ports. */
export async function reservePortWindow(span = 3) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = RANGE_START + Math.floor(Math.random() * (RANGE_SIZE - span));
    let ok = true;
    for (let i = 0; i < span && ok; i++) ok = await canBind(base + i);
    if (ok) return base;
  }
  throw new Error(`no free window of ${span} ports in ${RANGE_START}-${RANGE_START + RANGE_SIZE}`);
}

/**
 * Reserve a window and bind a server inside it, retrying with a fresh window
 * if the port is stolen between the check and the bind. `start` is called with
 * the port to bind (base + offset); anything it throws other than EADDRINUSE
 * propagates. Resolves { server, base }.
 */
export async function startInWindow(start, { span = 3, offset = 0, attempts = 10 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const base = await reservePortWindow(span);
    try {
      return { server: await start(base + offset), base };
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('could not bind a server in any reserved window');
}

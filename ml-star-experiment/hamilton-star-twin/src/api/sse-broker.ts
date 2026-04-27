/**
 * Server-Sent Events broker (Step 2.2)
 *
 * One instance per HTTP server. Tracks connected SSE clients and fans out
 * `broadcast(type, data)` to all of them. Owns nothing else — no business
 * logic, no twin state, no route handling.
 *
 * This is the shared transport both the REST layer (src/api/rest-api.ts)
 * and the replay service (src/services/replay-service.ts) push through, so
 * live-push events end up on one wire regardless of which subsystem emits
 * them.
 *
 * Clients are added with `attachClient(res)` — the broker writes the SSE
 * handshake, registers the response, and returns a detach function the
 * caller wires to the socket's `close` event.
 */

import type * as http from "http";

export class SseBroker {
  private clients: Set<http.ServerResponse> = new Set();

  /**
   * Register an HTTP response as an SSE client. Writes the SSE headers
   * and a `connected` handshake event, then keeps the connection open.
   * Returns a detach function — call it when the socket closes so the
   * client is removed from the fan-out set.
   */
  attachClient(res: http.ServerResponse): () => void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    try {
      res.write("event: connected\ndata: {}\n\n");
    } catch {
      // Socket died during handshake — don't register.
      return () => { /* no-op */ };
    }
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  /**
   * Fan out a typed event to every connected client. Silently drops
   * clients that error on write (usually means the socket went away);
   * never throws — the twin must keep running even if a browser tab dies.
   */
  broadcast(type: string, data: unknown): void {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(msg);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Count of currently connected clients. Useful for diagnostics. */
  clientCount(): number {
    return this.clients.size;
  }

  /**
   * End every open SSE connection and clear the registry. Used by the
   * headless server during shutdown and by the test helper between tests.
   */
  closeAll(): void {
    for (const client of this.clients) {
      try { client.end(); } catch { /* already closed */ }
    }
    this.clients.clear();
  }
}

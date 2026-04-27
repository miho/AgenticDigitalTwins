/**
 * SSE broker tests (Step 2.2).
 *
 * Plain fan-out logic — exercise it with fake ServerResponse objects that
 * capture write() calls. No real HTTP needed.
 *
 * FAILURE INJECTION
 *   - If broadcast() forgets the `event: <type>` prefix, the "broadcast
 *     formats SSE frames correctly" test fails.
 *   - If a throwing client isn't removed, "broadcast drops clients that
 *     throw on write" keeps delivering to the dead client.
 *   - If closeAll() doesn't clear the set, a new broadcast after closeAll
 *     still hits the old clients and "closeAll clears the registry" fails.
 */
import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SseBroker } = require("../../dist/api/sse-broker");

interface FakeRes {
  writeHead: (status: number, headers?: Record<string, string>) => void;
  write: (chunk: string) => boolean;
  end: () => void;
  headersWritten?: Record<string, string>;
  statusWritten?: number;
  writes: string[];
  ended: boolean;
  throwOnWrite?: boolean;
}

function makeFakeRes(throwOnWrite = false): FakeRes {
  const res: FakeRes = {
    writes: [],
    ended: false,
    throwOnWrite,
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusWritten = status;
      this.headersWritten = headers;
    },
    write(chunk: string) {
      if (this.throwOnWrite) throw new Error("socket dead");
      this.writes.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
  };
  return res;
}

describe("SseBroker (Step 2.2)", () => {
  it("attachClient writes SSE headers and a connected handshake", () => {
    const broker = new SseBroker();
    const res = makeFakeRes();
    broker.attachClient(res as any);
    expect(res.statusWritten).toBe(200);
    expect(res.headersWritten?.["Content-Type"]).toBe("text/event-stream");
    expect(res.headersWritten?.["Cache-Control"]).toBe("no-cache");
    expect(res.headersWritten?.["Connection"]).toBe("keep-alive");
    expect(res.writes[0]).toContain("event: connected");
  });

  it("broadcast formats SSE frames correctly", () => {
    const broker = new SseBroker();
    const a = makeFakeRes();
    const b = makeFakeRes();
    broker.attachClient(a as any);
    broker.attachClient(b as any);

    broker.broadcast("command-result", { raw: "C0ASid0001", ok: true });
    const frameA = a.writes[a.writes.length - 1];
    const frameB = b.writes[b.writes.length - 1];
    expect(frameA).toBe(frameB);
    expect(frameA).toContain("event: command-result");
    expect(frameA).toContain("\"raw\":\"C0ASid0001\"");
    expect(frameA.endsWith("\n\n")).toBe(true);
  });

  it("broadcast drops clients that throw on write", () => {
    const broker = new SseBroker();
    const good = makeFakeRes();
    const bad = makeFakeRes();
    broker.attachClient(good as any);
    broker.attachClient(bad as any);
    expect(broker.clientCount()).toBe(2);

    // Simulate the bad client's socket dying AFTER successful attach — the
    // next broadcast's write() will throw.
    bad.throwOnWrite = true;

    broker.broadcast("ping", {});
    // Bad client removed, good client still present and received the frame.
    expect(broker.clientCount()).toBe(1);
    expect(good.writes.some((w) => w.includes("event: ping"))).toBe(true);
  });

  it("attachClient silently drops a client whose socket dies during handshake", () => {
    const broker = new SseBroker();
    const res = makeFakeRes(true);
    broker.attachClient(res as any);
    expect(broker.clientCount()).toBe(0);
  });

  it("detach function removes the client from the registry", () => {
    const broker = new SseBroker();
    const res = makeFakeRes();
    const detach = broker.attachClient(res as any);
    expect(broker.clientCount()).toBe(1);
    detach();
    expect(broker.clientCount()).toBe(0);
    // Subsequent broadcast does not reach the detached client.
    const writesBefore = res.writes.length;
    broker.broadcast("ping", {});
    expect(res.writes.length).toBe(writesBefore);
  });

  it("closeAll ends all clients and clears the registry", () => {
    const broker = new SseBroker();
    const a = makeFakeRes();
    const b = makeFakeRes();
    broker.attachClient(a as any);
    broker.attachClient(b as any);
    broker.closeAll();
    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(broker.clientCount()).toBe(0);
  });

  it("broadcast with no clients is a no-op (does not throw)", () => {
    const broker = new SseBroker();
    expect(() => broker.broadcast("nobody-listening", { x: 1 })).not.toThrow();
  });
});

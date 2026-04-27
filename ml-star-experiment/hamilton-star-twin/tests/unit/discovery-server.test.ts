/**
 * BDZ discovery wire-format tests.
 *
 * Pins the text that goes on the wire so regressions can't quietly break
 * real-VENUS discovery. Every field name and terminator here is
 * cross-referenced to VENUS source:
 *
 *   VENUS-2026-04-13/Vector/src/HxTcpIpBdzComm/CODE/Shared/
 *     ModuleControllerInfo.cpp:21-31  DiscoveryCommandName/HeaderId/Ports
 *     ModuleControllerInfo.cpp:106-212 ParseModuleControllerAnswer — the
 *     parser these responses have to satisfy.
 *   VENUS-2026-04-13/Vector/src/HxTcpIpBdzComm/CODE/Shared/
 *     DeviceControllerInfo.cpp:66-169 Parse_R_GETDEVICELIST.
 *   VENUS-2026-04-13/Vector/src/HxTcpIpBdzComm/CODE/Shared/
 *     BaseSocket.cpp:39 message delimiter = "\r\n".
 *   VENUS-2026-04-13/Star/src/HxStarConfig/code/
 *     HxStarConfigClass.cs:1339 ModuleTypeStarPipettor = "MLSTARPipettor"
 *     HxStarConfigClass.cs:1367 protocol == 2 filter
 *
 * FAILURE INJECTION
 *   - Drop the trailing `\r\n` from the UDP reply: VENUS's
 *     CAsyncMessageSocket::OnReceive splits on "\r\n" (line 118), so a
 *     missing terminator means the probe response is never dispatched.
 *     The "ends with CRLF" assertion fails first.
 *   - Flip bdc_modulename to anything other than "MLSTARPipettor" and
 *     VENUS's filter at HxStarConfigClass.cs:1423 drops the instrument
 *     from the picker. The "modulename must be MLSTARPipettor" test
 *     fails first.
 *   - Flip r_device_interfaceprotocol away from "2" and VENUS ignores
 *     the device in its "protocol == 2" check. The "fdx protocol ==
 *     2" test fails first.
 *   - Change the enumeration terminator from `r_device_used 0` to
 *     anything else and VENUS keeps asking for device_nr 3, 4, … until
 *     it hits the 64-device cap — the enumeration never terminates
 *     cleanly. The terminator test fails first.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as dgram from "dgram";
import * as net from "net";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_HAMSMART_PORT,
  DEFAULT_FW_PORT,
  HEADER_ID,
  DISCOVERY_COMMAND,
  STAR_MODULE_TYPE,
  FDX_INTERFACE_PROTOCOL,
  TCPIP_INTERFACE_TYPE,
  buildBroadcastResponse,
  buildDeviceListReply,
  buildDeviceListTerminator,
  defaultIdentity,
  startDiscoveryService,
} = require("../../dist/services/bdz-bridge/discovery-server");

describe("discovery-server — protocol constants", () => {
  it("uses the VENUS well-known ports", () => {
    expect(DEFAULT_DISCOVERY_PORT).toBe(34569);
    expect(DEFAULT_HAMSMART_PORT).toBe(34567);
    expect(DEFAULT_FW_PORT).toBe(9999);
  });

  it("matches VENUS's header id magic number 0x87654321", () => {
    expect(HEADER_ID).toBe("2271560481");
  });

  it("matches VENUS's discovery command name", () => {
    expect(DISCOVERY_COMMAND).toBe("HAMILTON_BROADCAST");
  });

  it("uses the STAR module-type filter VENUS expects", () => {
    expect(STAR_MODULE_TYPE).toBe("MLSTARPipettor");
  });

  it("advertises FDx interface-protocol = 2", () => {
    expect(FDX_INTERFACE_PROTOCOL).toBe("2");
  });

  it("advertises TCP/IP interface-type = 1", () => {
    expect(TCPIP_INTERFACE_TYPE).toBe("1");
  });
});

describe("discovery-server — default identity", () => {
  it("identifies as MLSTARPipettor so VENUS lists it", () => {
    const id = defaultIdentity();
    expect(id.moduleType).toBe("MLSTARPipettor");
    expect(id.deviceType).toBe("MLSTARPipettor");
  });

  it("points FDx at the phase-5 default port", () => {
    const id = defaultIdentity();
    expect(id.fwPort).toBe(9999);
    expect(id.hamSmartPort).toBe(34567);
  });

  it("accepts overrides", () => {
    const id = defaultIdentity({ instrumentId: "Custom STAR", moduleId: "42" });
    expect(id.instrumentId).toBe("Custom STAR");
    expect(id.moduleId).toBe("42");
    expect(id.moduleType).toBe("MLSTARPipettor"); // unchanged
  });
});

describe("discovery-server — UDP response format", () => {
  const id = defaultIdentity({ ipAddress: "192.168.1.42" });

  it("ends with CRLF — VENUS message-socket splitter", () => {
    const buf = buildBroadcastResponse(id, 1);
    const text = buf.toString("ascii");
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("starts with HAMILTON_BROADCAST + bdc_headerid 2271560481", () => {
    const text = buildBroadcastResponse(id, 7).toString("ascii");
    expect(text.startsWith("HAMILTON_BROADCAST bdc_headerid 2271560481 ")).toBe(true);
  });

  it("includes every field VENUS's parser consumes", () => {
    const text = buildBroadcastResponse(id, 7).toString("ascii");
    // ParseModuleControllerAnswer in ModuleControllerInfo.cpp:106 consumes
    // exactly these keys; missing any one drops the response on the floor.
    for (const key of [
      "bdc_headerid",
      "bdc_counter",
      "bdc_ipstate",
      "bdc_ipaddress",
      "bdc_macaddress",
      "bdc_systemid",
      "bdc_modulename",
      "bdc_moduledesc",
      "bdc_modulenumber",
      "bdc_modulemode",
      "bdc_hamsmartport",
    ]) {
      expect(text.includes(` ${key} `)).toBe(true);
    }
  });

  it("bdc_modulename must be MLSTARPipettor (HxStarConfigClass.cs:1423 filter)", () => {
    const text = buildBroadcastResponse(id, 1).toString("ascii");
    expect(text).toMatch(/ bdc_modulename "MLSTARPipettor" /);
  });

  it("advertises the hamsmart port VENUS will connect to next", () => {
    const custom = defaultIdentity({ hamSmartPort: 40000 });
    const text = buildBroadcastResponse(custom, 1).toString("ascii");
    expect(text).toMatch(/ bdc_hamsmartport 40000/);
  });

  it("increments counter caller-side (each probe should be distinct)", () => {
    const a = buildBroadcastResponse(id, 1).toString("ascii");
    const b = buildBroadcastResponse(id, 2).toString("ascii");
    expect(a).toMatch(/ bdc_counter 1 /);
    expect(b).toMatch(/ bdc_counter 2 /);
  });
});

describe("discovery-server — R_GETDEVICELIST format", () => {
  const id = defaultIdentity();

  it("device reply ends with CRLF", () => {
    const text = buildDeviceListReply(id).toString("ascii");
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("device reply carries every field Parse_R_GETDEVICELIST needs", () => {
    const text = buildDeviceListReply(id).toString("ascii");
    for (const key of [
      "er 0",
      "r_device_used 1",
      "r_device_state 1",
      "r_device_name",
      "r_device_number",
      "r_device_interfacetype",
      "r_device_interfacedata",
      "r_device_description",
      "r_device_interfaceprotocol",
    ]) {
      expect(text.includes(key)).toBe(true);
    }
  });

  it("fdx protocol == 2 (HxStarConfigClass.cs:1367 filter)", () => {
    const text = buildDeviceListReply(id).toString("ascii");
    expect(text).toMatch(/ r_device_interfaceprotocol 2/);
  });

  it("interfacetype 1 + interfacedata = fwPort (GetDeviceTcpPort)", () => {
    const text = buildDeviceListReply({ ...id, fwPort: 12345 }).toString("ascii");
    expect(text).toMatch(/ r_device_interfacetype 1 /);
    expect(text).toMatch(/ r_device_interfacedata "12345" /);
  });

  it("terminator stops ModuleControllerSocket::OnMessage enumeration", () => {
    // ModuleControllerSocket.cpp:120: "sDeviceUsed != '1'" ends enumeration.
    const text = buildDeviceListTerminator().toString("ascii");
    expect(text).toBe("R_GETDEVICELIST er 0 r_device_used 0\r\n");
  });
});

describe("discovery-server — live UDP+TCP integration", () => {
  // Bind both halves on ephemeral ports so tests don't need admin
  // privileges or conflict with a real VENUS install on 34567/34569.
  let handle: any | null = null;

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
  });

  it("serves a device-list + terminator over TCP hamsmart", async () => {
    const localIdentity = defaultIdentity({
      instrumentId: "Test STAR",
      moduleId: "12345",
      ipAddress: "127.0.0.1",
      hamSmartPort: 0, // filled by HamSmartServer
      fwPort: 9999,
    });
    handle = await startDiscoveryService({
      identity: localIdentity,
      discoveryPort: 0,
      hamSmartPort: 0,
      host: "127.0.0.1",
    });
    const port = handle.hamsmart.port;
    expect(port).toBeGreaterThan(0);

    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection({ host: "127.0.0.1", port }, () => {
        client.write("R_GETDEVICELIST device_nr 1\r\n");
      });
      let buf = "";
      client.setEncoding("ascii");
      client.on("data", (chunk: string) => {
        buf += chunk;
        while (true) {
          const idx = buf.indexOf("\r\n");
          if (idx === -1) break;
          received.push(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
          if (received.length === 1) {
            client.write("R_GETDEVICELIST device_nr 2\r\n");
          } else if (received.length === 2) {
            client.end();
            resolve();
          }
        }
      });
      client.on("error", reject);
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toMatch(/^R_GETDEVICELIST er 0 r_device_used 1 /);
    expect(received[0]).toMatch(/ r_device_interfaceprotocol 2$/);
    expect(received[1]).toBe("R_GETDEVICELIST er 0 r_device_used 0");
  });

  it("answers real UDP probes with a valid broadcast response", async () => {
    // Find an ephemeral UDP port we can claim for the responder.
    const ephemeral = await pickFreeUdpPort();
    handle = await startDiscoveryService({
      identity: defaultIdentity({
        instrumentId: "Test STAR",
        moduleId: "12345",
        ipAddress: "127.0.0.1",
        hamSmartPort: 0,
        fwPort: 9999,
      }),
      discoveryPort: ephemeral,
      hamSmartPort: 0,
      host: "127.0.0.1",
    });

    const reply = await new Promise<string>((resolve, reject) => {
      const client = dgram.createSocket("udp4");
      const timer = setTimeout(() => {
        client.close();
        reject(new Error("no reply from discovery responder"));
      }, 2000);
      client.on("message", (msg) => {
        clearTimeout(timer);
        client.close();
        resolve(msg.toString("ascii"));
      });
      client.on("error", (err) => {
        clearTimeout(timer);
        client.close();
        reject(err);
      });
      const probe = Buffer.from(`HAMILTON_BROADCAST bdc_headerid 2271560481\r\n`, "ascii");
      client.send(probe, ephemeral, "127.0.0.1", (err) => {
        if (err) {
          clearTimeout(timer);
          client.close();
          reject(err);
        }
      });
    });

    expect(reply.startsWith("HAMILTON_BROADCAST")).toBe(true);
    expect(reply).toMatch(/ bdc_modulename "MLSTARPipettor" /);
    expect(reply).toMatch(/ bdc_modulenumber "12345" /);
    expect(reply.endsWith("\r\n")).toBe(true);
  });

  it("ignores probes that don't carry the HAMILTON_BROADCAST + headerid signature", async () => {
    const ephemeral = await pickFreeUdpPort();
    handle = await startDiscoveryService({
      identity: defaultIdentity({ ipAddress: "127.0.0.1" }),
      discoveryPort: ephemeral,
      hamSmartPort: 0,
      host: "127.0.0.1",
    });

    // Send garbage + a wrong-header probe; expect silence (timeout).
    await new Promise<void>((resolve, reject) => {
      const client = dgram.createSocket("udp4");
      const timer = setTimeout(() => {
        client.close();
        resolve(); // success: nothing arrived
      }, 500);
      client.on("message", (msg) => {
        clearTimeout(timer);
        client.close();
        reject(new Error(`unexpected reply: ${msg.toString("ascii")}`));
      });
      const junk = Buffer.from("HAMILTON_BROADCAST bdc_headerid 0\r\n", "ascii");
      client.send(junk, ephemeral, "127.0.0.1");
    });
  });
});

/** Pick an unused high UDP port by binding to 0 and reading it back. */
async function pickFreeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", reject);
    sock.bind({ address: "127.0.0.1", port: 0, exclusive: true }, () => {
      const addr = sock.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      sock.close(() => resolve(port));
    });
  });
}

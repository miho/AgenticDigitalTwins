# Unit tests

Pure-function and in-process twin tests. No HTTP server, no browser.

## Running

```bash
npm run test:unit
```

## Authoring guidelines

- Use `createTestTwin()` from `tests/helpers/in-process.ts` — never a hardcoded HTTP port.
- Read `tests/TESTING-GUIDE.md` before writing new tests.
- Test one thing per `it()`. If you need multiple assertions, they should all relate to the same contract.
- Name describe blocks after the unit under test: `describe("FwProtocol.parseFwCommand", ...)`.

## Examples

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createTestTwin } from "../helpers/in-process";

describe("DigitalTwin.sendCommand", () => {
  let twin: ReturnType<typeof createTestTwin>;

  beforeEach(() => {
    twin = createTestTwin();
  });

  it("initializes master module on C0VI", () => {
    const result = twin.sendCommand("C0VIid0001");
    expect(result.accepted).toBe(true);
    expect(result.activeStates.master).toContain("sys_ready");
  });
});
```

## What belongs here

- Parsers, formatters, validators (fw-protocol, command-interpreter).
- Physics calculations (well-geometry, command-timing).
- State serialization round-trips.
- Individual plugin logic.
- SCXML executor wrappers.
- Helpers and utilities.

## What does NOT belong here

- Tests that require the HTTP server → `tests/integration/`.
- Tests that exercise the UI → `tests/e2e/`.
- Tests that verify API response shapes → `tests/contract/`.

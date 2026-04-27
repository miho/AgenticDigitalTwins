# Contract tests

Verify API endpoint and MCP tool response shapes. Protects against accidental breaking changes to the public surface.

## Running

```bash
npm run test:contract
```

## Authoring guidelines

- Use a fresh test server started per file via `createTestServer()` — never `http://localhost:8222`.
- Each endpoint gets at least one contract test that snapshots a representative response.
- Snapshots live in `tests/contract/__snapshots__/` and are reviewed during code review.
- A snapshot change is a change to the public contract. Treat it as such.

## What belongs here

- HTTP endpoint tests asserting response shape (`/state`, `/command`, `/tracking`, etc.).
- MCP tool tests asserting tool argument and return shapes.
- SSE event shape tests.

## What does NOT belong here

- Behavioral tests (does aspirate actually deplete wells?) → `tests/integration/`.
- Unit-level parser/formatter tests → `tests/unit/`.

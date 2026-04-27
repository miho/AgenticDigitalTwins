# Test helpers

Shared utilities for unit, integration, contract, and e2e tests.

| Helper | Purpose |
|---|---|
| `in-process.ts` | `createTestTwin()` — instantiate a `DigitalTwinAPI` directly for unit tests |
| `test-server.ts` | `createTestServer()` — spawn a fresh HTTP server on a random port for integration tests |
| `wait-for.ts` | `waitForModuleState()`, `waitFor()` — poll-based waits that replace magic `setTimeout` |
| (existing) `../integration/helpers.ts` | HTTP-based helpers for integration tests — uses the base URL from the active test server |

## Design

- Unit tests avoid HTTP entirely. They get a `DigitalTwinAPI` instance and call methods directly.
- Integration tests use a test server on a random port. Multiple test files can run in sequence without port conflicts.
- No hardcoded `localhost:8222` anywhere in new tests. Legacy integration tests in `tests/integration/` migrate to the test-server pattern over time.

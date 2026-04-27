# Test Plan — Hamilton STAR Digital Twin

## Test Levels

### Level 1: Unit Tests (`tests/unit/`) — TODO
Pure logic, no server, no browser. Fast and deterministic.

- [ ] **FW Protocol Parser** — roundtrip parse/format for all command types, array params, edge cases
- [ ] **SCXML State Machines** — direct executor: send events, verify state transitions, variable changes per module
- [ ] **Physics Plugins** — timing calculations (PIP move, aspirate/dispense speed), temperature ramps, fluid depletion
- [ ] **Deck Tracker** — coordinate resolution, well volume accounting, tip usage, liquid identity tracking
- [ ] **Assessment Engine** — event generation, category/severity, TADM curve data structure

### Level 2: Integration Tests (`tests/integration/`) — DONE
HTTP API tests against running twin. 27 tests covering:

- [x] Initial state (10 modules, 8 carriers, master sys_ready)
- [x] Fill plate (96 wells, liquid type tracking)
- [x] Tip pickup (8ch, 4ch subset, tip usage tracking)
- [x] Aspirate (volume tracking, well depletion, TADM assessment)
- [x] Dispense (destination fill, TADM assessment)
- [x] Volume conservation (8ch and 4ch transfers, source+dest=original)
- [x] Temperature control (TCC ramp, HHS heat+shake, overtemp rejection)
- [x] Wash station (init, fluid depletion, cycle counting, assessment events)
- [x] 96-Head (move, tip pickup, aspirate, dispense, eject, pos_y tracking)
- [x] Error paths (no-tip aspirate, double tip pickup, no-volume dispense)
- [x] End-to-end workflow consistency (no error states after valid workflow)

### Level 3: E2E / Visual Tests (`tests/e2e/`) — TODO
Playwright browser tests verifying SVG rendering and UI interaction.

- [ ] **Ghost head** — click snap, pitch auto-detection (90 vs 45), channel mask dot colors
- [ ] **SVG alignment** — ghost dots cy match well cy for 96-well and 384-well
- [ ] **Inspector** — well-filled count, tooltip text, fill level opacity
- [ ] **Deck tooltips** — hover shows "A1: 100uL Sample_A"
- [ ] **Theme toggle** — CSS variable resolution in light/dark, inspector SVG bg
- [ ] **Context menu** — action execution, channel toggle, pitch selector
- [ ] **Arm overlays** — PIP/96-head/iSWAP position matches module state
- [ ] **Module visuals** — HHS temp/shake, TCC temp bar, wash fluid levels

### CI Pipeline — TODO

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
      - run: npx vitest run tests/unit

  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run build
      - run: npx electron dist/main/main.js &
      - run: sleep 5
      - run: npx vitest run tests/integration

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci && npx playwright install
      - run: npm run build
      - run: npx electron dist/main/main.js &
      - run: sleep 5
      - run: npx vitest run tests/e2e
```

## Running Tests

```bash
# All tests (requires twin running)
npm test

# Watch mode
npm run test:watch

# Integration only
npx vitest run tests/integration

# Start twin + run tests
npm run build && npx electron dist/main/main.js &
sleep 3 && npm test
```

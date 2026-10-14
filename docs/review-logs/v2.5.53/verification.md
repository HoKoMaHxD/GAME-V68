# Verification — v2.5.53

## Results

- Targeted reset, runtime control, ship, shared interaction and financial-log tests: **137 passed, 0 failed** (`targeted-tests.txt`).
- Full `npm test`: **1,072 tests, 1,065 passed, 7 failed** (`full-tests.txt`). All seven failures also reproduce in the unchanged v2.5.52 archive using the same installed dependencies (`baseline-robbery-tests.txt`: 122 tests, 115 passed, 7 failed). They concern existing robbery zero-balance rules, protection/timeout expectations and old reply text; this update does not change those rules.
- `npm run check`: syntax checks passed (`syntax.txt`).
- No live Discord session or production MongoDB was used. Database recovery tests use the project's in-memory collection fixture with injected before/after-write failures, not a running MongoDB server.

## Four ships

New rounds have ships of lengths **3, 2, 1, 1** on a **5-column × 4-row** board. The seven occupied cells match the previous quick mode, keeping the search area and required hits unchanged. Each turn has 20 direct target buttons and a private-fleet button; setup uses randomize/ready buttons. No row dropdown is used for new rounds.

Random legal placement, bounds, separation, one-cell sinking, extra turns on hits, full victory, timeout, balance settlement, duplicate and stale clicks, private ownership and public masking are covered. Existing three-ship quick rounds and original six-ship rounds complete with their saved rules and payouts.

`public-board.png` and `private-board.png` were rendered by the shipped renderer and visually inspected. Public images reveal sunk ships and hit/miss markers only. `public-controls.json` records the matching button layout: four rows of five target buttons and one private-fleet button.

## Full reset

Tests cover bulk deletion scoped to one clan, active game stakes/cooldowns, replacement of a hung service queue, draining issued writes, rejecting late old writes after resume, interrupted deletion and startup recovery, automatic retry, lost completion acknowledgments, duplicate requests retaining new balances/cutoffs, stock reservation rollback once, configuration preservation, authorization input validation and required worker lease.

The full reset pauses the service, clears operational member data and outstanding journals, records a durable cutoff and resumes. Existing bot setup remains configured. No production reset was executed while preparing this archive.

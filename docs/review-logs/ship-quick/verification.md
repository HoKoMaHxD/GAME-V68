# Quick ship game verification — v2.5.52

- 72 targeted tests passed, 0 failures: 27 ship tests, bank commands and shared game interaction tests.
- Syntax checks passed via `npm run check`.
- Three ships (3, 2, 2 cells), 5 columns × 4 rows; 20 direct target buttons plus one private-fleet button. No dropdown or row-selection step in new rounds.
- Random legal layouts, bounds, no overlap/touching, direct hits/misses, full victory, duplicate/stale clicks, timeout, private ownership and hidden-fleet masking tested.
- Money reservation, payout/refund and interrupted-write recovery remain covered.
- A legacy round without the new mode field was accepted, rerolled, restarted and played through all six original ships; its coordinates and payout remained intact.
- Rendered public/private board previews inspected; public target buttons do not reveal unhit ships.
- No live Discord or production MongoDB exercised. Earlier full-suite results are in `../ship`; this change was verified using the targeted suite above.

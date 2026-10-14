# Ship game verification — v2.5.51

- 26 ship tests passed, including randomized layouts, ownership/privacy, preparation, attack turns, timeouts, persistence, wallet-journal recovery, private/public message separation, and deferred interaction acknowledgement.
- 150 targeted tests passed across ship, dot, boxes, game interactions, resets, spam settings and runtime control.
- Final ship + bank command run: 50 tests passed.
- Earlier complete suite: 1058 tests; 1050 passed, 8 failed. Seven robbery failures were reproduced on the original uploaded archive. The remaining failure was an outdated command-description expectation; it was corrected and the final ship + bank run passed all 50 tests.
- Latest complete rerun reported 68 test files: 62 passed, 6 failed. Five failing files contain the existing robbery failures; startup.test.js additionally encountered sandbox EPERM when spawning Node child processes. No startup code or tests were changed to bypass that restriction.
- Final direct ship test run in the current environment: 26 passed, 0 failed.
- Syntax checks passed. The last subsequent changes were documentation and the Arabic score wording; the updated ship command file passed node --check.
- Public and private PNG previews were rendered and inspected; public rendering never exposes an unhit ship and private rendering is independent of the opponent's hidden layout.
- No live Discord deployment or production MongoDB access performed. Recovery tests use the project's in-memory MongoDB collection fixture.

import { runApplication } from './startup.js';

// Import after the boot marker so early dependency and configuration failures
// are reported with a stage and redacted details, including with `node src/index.js`.
if (await runApplication(() => import('./app.js'))) process.exit(1);

import { runAuthDiagnostics } from '../src/auth.js';

process.exitCode = await runAuthDiagnostics();

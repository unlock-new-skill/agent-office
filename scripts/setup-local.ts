import path from 'node:path';
import { AuthService } from '../src/server/auth/auth-service.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db/database.js';
import { DataLock } from '../src/server/data-lock.js';
import { assertSupportedRuntime } from '../src/server/runtime.js';
import { readNewPassword } from './password-prompt.js';

assertSupportedRuntime();
const config = loadConfig(); const lock = new DataLock(config.dataDir); lock.acquire();
const db = new Database({ filename: path.join(config.dataDir, 'agent-office.sqlite') }); const auth = new AuthService(db, config.sessionTtlSeconds, config.minPasswordLength);
try {
  if (auth.isSetupComplete()) { process.stdout.write('Manager already set up; use npm run reset to change the password.\n'); }
  else { auth.setupPassword(await readNewPassword(config.minPasswordLength)); process.stdout.write(`Initialized manager auth at ${config.dataDir}\n`); }
} catch (error) {
  process.stderr.write(`Setup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1;
} finally { db.close(); lock.release(); }

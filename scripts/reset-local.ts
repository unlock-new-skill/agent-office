import path from 'node:path';
import { AuthService } from '../src/server/auth/auth-service.js';
import { loadConfig } from '../src/server/config.js';
import { Database } from '../src/server/db/database.js';
import { DataLock } from '../src/server/data-lock.js';
import { assertSupportedRuntime } from '../src/server/runtime.js';
import { readNewPassword, readPassword } from './password-prompt.js';

assertSupportedRuntime();
const config = loadConfig(); const lock = new DataLock(config.dataDir); lock.acquire();
const db = new Database({ filename: path.join(config.dataDir, 'agent-office.sqlite') });
try {
  const current = await readPassword('Current manager password: '); const next = await readNewPassword(config.minPasswordLength);
  new AuthService(db, config.sessionTtlSeconds, config.minPasswordLength).resetPassword(current, next);
  process.stdout.write('Manager password reset; all sessions and agent credentials revoked.\n');
} finally { db.close(); lock.release(); }

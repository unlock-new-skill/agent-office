import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../../src/server/db/database.js';
import { AuthService } from '../../src/server/auth/auth-service.js';

test('local auth bootstrap allows one setup and verifies a password session', () => {
  const db = new Database({ filename: ':memory:' });
  const auth = new AuthService(db, 3600);
  assert.equal(auth.isSetupComplete(), false);
  auth.setupPassword('correct horse battery staple');
  assert.equal(auth.isSetupComplete(), true);
  assert.throws(() => auth.setupPassword('another password here'), /already_setup/);
  const result = auth.login('correct horse battery staple');
  assert.ok(result.token.length > 20);
  assert.throws(() => auth.login('wrong password'), /invalid_credentials/);
  db.close();
});

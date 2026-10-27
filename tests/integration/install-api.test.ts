import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppFixture, HOST } from '../helpers/office-fixture.js';

type Created = { code: string; uses: number; commands: { unix: string; windows: string } };
const redeem = (fixture: ReturnType<typeof createAppFixture>, code: string, peer = '1.2.3.4'): Promise<Response> =>
  Promise.resolve(fixture.app.request(`http://${HOST}/v1/install/redeem`, { method: 'POST', headers: { host: HOST, authorization: `Bearer ${code}`, 'x-agent-office-peer': peer, 'content-type': 'application/json' }, body: '{}' }));

test('manager mints an install code; each use yields a working connector credential until used up', async () => {
  const fixture = createAppFixture();
  assert.equal((await fixture.agent('nope', '/v1/install-codes', { body: {} })).status, 401);
  const created = await (await fixture.manager('/v1/install-codes', { body: { uses: 2 } })).json() as Created;
  assert.equal(created.commands.unix, `curl -fsSL http://${HOST}/install.sh | sh -s -- ${created.code}`);
  assert.equal(created.commands.windows, `$env:AGENT_OFFICE_CODE='${created.code}'; irm http://${HOST}/install.ps1 | iex`);
  for (let i = 0; i < 2; i++) {
    const response = await redeem(fixture, created.code);
    assert.equal(response.status, 201);
    const { token, daemonUrl } = await response.json() as { token: string; daemonUrl: string };
    assert.equal(daemonUrl, `http://${HOST}`);
    const registered = await fixture.agent(token, '/v1/sessions/register', { body: { sessionId: `machine-${i}`, project: 'p' } });
    assert.equal(registered.status, 201, 'redeemed token works as a connector');
  }
  assert.equal((await redeem(fixture, created.code)).status, 401, 'used up');
  assert.equal((await redeem(fixture, 'guess')).status, 401);
  fixture.close();
});

test('redeem is rate limited per client; scripts embed the origin', async () => {
  const fixture = createAppFixture();
  for (let i = 0; i < 10; i++) await redeem(fixture, `guess-${i}`, '9.9.9.9');
  assert.equal((await redeem(fixture, 'guess-x', '9.9.9.9')).status, 429);
  const sh = await fixture.app.request(`http://${HOST}/install.sh`, { headers: { host: HOST } });
  assert.equal(sh.status, 200);
  assert.ok((await sh.text()).includes(`ORIGIN='http://${HOST}'`));
  const ps1 = await (await fixture.app.request(`http://${HOST}/install.ps1`, { headers: { host: HOST } })).text();
  assert.ok(ps1.includes(`$Origin = 'http://${HOST}'`));
  fixture.close();
});

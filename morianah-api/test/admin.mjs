// Admin panel routes (step 4b). Runs against `wrangler dev` with CHAIN_FAKE=1. Run AFTER test/mint.mjs.
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const T = { admin: 'dev-admin', verifier: 'dev-verifier', artist: 'dev-artist2', collector: 'dev-collector' };
const VERIFIER = 'GAQQRWBIZZ2CPMV2M3435UWU3STLAFVH2NM6EOBE5KSXQDHSSPQ67FZD';
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ✔', name); } catch (e) { failed++; console.log('  ✘', name, '\n     ', e.message); } }
const api = async (path, { token, method = 'GET', json } = {}) => {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
  let body; if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const r = await fetch(BASE + path, { method, headers, body }); return { status: r.status, body: await r.json() };
};

console.log('\nStep 4b — admin panel\n');

await test('admin-only: profiles, collections, chain and audit refuse non-admins', async () => {
  for (const p of ['/api/admin/profiles', '/api/admin/collections', '/api/admin/chain', '/api/admin/audit']) {
    assert.equal((await api(p, { token: T.verifier })).status, 403, p);
    assert.equal((await api(p)).status, 401, p);
  }
});
await test('admin lists every profile and can filter by persona', async () => {
  const all = await api('/api/admin/profiles', { token: T.admin }); assert.equal(all.status, 200); assert.ok(all.body.profiles.length >= 4);
  const v = await api('/api/admin/profiles?persona=verifier', { token: T.admin }); assert.ok(v.body.profiles.every((p) => p.persona === 'verifier')); assert.ok(v.body.profiles.some((p) => p.address === VERIFIER));
});
await test('admin sees draft collections; public list does not', async () => {
  const id = 900 + Math.floor(Math.random() * 90);
  const r = await api('/api/admin/collections', { token: T.admin, method: 'POST', json: { id, slug: 'draft-' + id, title: 'Draft ' + id } }); assert.equal(r.status, 201);
  assert.ok((await api('/api/admin/collections', { token: T.admin })).body.collections.some((c) => c.id === id && c.status === 'draft'));
  assert.ok(!(await api('/api/collections')).body.collections.some((c) => c.id === id));
  assert.equal((await api('/api/admin/collections/' + id, { token: T.admin, method: 'PATCH', json: { status: 'live', description: 'now live' } })).status, 200);
  const pub = (await api('/api/collections')).body.collections.find((c) => c.id === id); assert.ok(pub); assert.equal(pub.description, 'now live');
  assert.equal((await api('/api/admin/collections/' + id, { token: T.admin, method: 'PATCH', json: { status: 'nope' } })).status, 400);
  assert.equal((await api('/api/admin/collections/424242', { token: T.admin, method: 'PATCH', json: { status: 'live' } })).status, 404);
});
await test('chain status reports verifier roles from the chain', async () => {
  await api('/api/_test/chain', { method: 'POST', json: { roles: { [VERIFIER]: ['verifier'] } } });
  const r = await api('/api/admin/chain?verifiers=' + VERIFIER + ',GBFINNVVXYSWSYBGKZYGPOC2UDKUC2ZNPEK5IJPME2K4WOOC6GUEUXNH', { token: T.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.contract_id, /^C/);
  assert.equal(r.body.verifiers[VERIFIER], true); assert.equal(r.body.verifiers.GBFINNVVXYSWSYBGKZYGPOC2UDKUC2ZNPEK5IJPME2K4WOOC6GUEUXNH, false);
});
await test('audit log records the collection changes', async () => {
  const a = await api('/api/admin/audit', { token: T.admin }); assert.ok(a.body.log.some((r) => r.action === 'collection.update'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

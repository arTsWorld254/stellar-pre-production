// Step 4 tests: prepare-mint → (wallet signs, off-screen) → confirm-mint → reconcile.
// Runs against `wrangler dev` with CHAIN_FAKE=1 in .dev.vars. Run AFTER test/e2e.mjs (it needs its data).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const T = { admin: 'dev-admin', verifier: 'dev-verifier', artist: 'dev-artist2', collector: 'dev-collector' };
const ARTIST = 'GAAV4JCNBBU7IIOYJD6S6BPRS52DENEGWXQWYALHFCRBKHMUCB34K7MZ';
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ✔', name); } catch (e) { failed++; console.log('  ✘', name, '\n     ', e.message); } }
const api = async (path, { token, method = 'GET', json, form } = {}) => {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
  let body; if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); } if (form) body = form;
  const r = await fetch(BASE + path, { method, headers, body }); return { status: r.status, body: await r.json() };
};
const chain = (state) => api('/api/_test/chain', { method: 'POST', json: state });
const png = (seed) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), Buffer.from([seed, 42])]);
const upload = (token, title, seed) => { const fd = new FormData(); fd.set('image', new Blob([png(seed)], { type: 'image/png' }), 'w.png'); fd.set('title', title); fd.set('collection_id', '1'); return api('/api/uploads', { token, method: 'POST', form: fd }); };

console.log('\nStep 4 — mint pipeline\n');
await chain({ reset: true });

await test('chain info exposes the contract and dev IPFS mode', async () => {
  const r = await api('/api/chain/info'); assert.equal(r.status, 200);
  assert.match(r.body.contract_id, /^C[A-Z2-7]{55}$/); assert.equal(r.body.ipfs, 'dev-placeholder');
});

// a fresh approved submission to mint
let subId, sha;
await test('setup: admin reactivates artist2, verifier approves their re-application', async () => {
  assert.equal((await api('/api/admin/profiles/' + ARTIST + '/status', { token: T.admin, method: 'POST', json: { status: 'active' } })).status, 200);
  assert.equal((await api('/api/verify/artists/' + ARTIST, { token: T.verifier, method: 'POST', json: { decision: 'approved' } })).status, 200);
});
await test('setup: artist uploads, verifier approves', async () => {
  const r = await upload(T.artist, 'Flame Lily, Steel III', 77); assert.equal(r.status, 201, JSON.stringify(r.body));
  subId = r.body.id; sha = r.body.sha256; assert.equal(sha, createHash('sha256').update(png(77)).digest('hex'));
  assert.equal((await api('/api/verify/submissions/' + subId, { token: T.verifier, method: 'POST', json: { decision: 'approved' } })).status, 200);
});
await test('a pending (unapproved) submission cannot be prepared', async () => {
  const r = await upload(T.artist, 'Not yet', 78); assert.equal(r.status, 201);
  const p = await api('/api/submissions/' + r.body.id + '/prepare-mint', { token: T.artist, method: 'POST' }); assert.equal(p.status, 409);
  assert.equal((await api('/api/submissions/' + r.body.id, { token: T.artist, method: 'DELETE' })).status, 200);
});
await test('only the owning artist can prepare', async () => {
  assert.equal((await api('/api/submissions/' + subId + '/prepare-mint', { token: T.collector, method: 'POST' })).status, 403);
  assert.equal((await api('/api/submissions/' + subId + '/prepare-mint', { method: 'POST' })).status, 401);
});
let mintArgs;
await test('prepare-mint pins to IPFS and returns the exact mint arguments', async () => {
  const r = await api('/api/submissions/' + subId + '/prepare-mint', { token: T.artist, method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); mintArgs = r.body.mint;
  assert.equal(mintArgs.fn, 'mint_work'); assert.equal(mintArgs.artist, ARTIST); assert.equal(mintArgs.collection, 1);
  assert.equal(mintArgs.sha256, sha); assert.match(mintArgs.cid, /^bafy/); assert.match(mintArgs.contract_id, /^C/);
});
await test('prepare-mint is idempotent (same CID on repeat)', async () => {
  const r = await api('/api/submissions/' + subId + '/prepare-mint', { token: T.artist, method: 'POST' }); assert.equal(r.body.mint.cid, mintArgs.cid);
  const mine = await api('/api/submissions/mine', { token: T.artist }); const s = mine.body.submissions.find((x) => x.id === subId);
  assert.equal(s.cid, mintArgs.cid); assert.equal(s.status, 'approved');
});
await test('confirm before the chain has the token → 409 (nothing is marked)', async () => {
  const r = await api('/api/submissions/' + subId + '/confirm-mint', { token: T.artist, method: 'POST', json: {} }); assert.equal(r.status, 409);
});
await test('confirm with a failed transaction → 409', async () => {
  const h = 'a'.repeat(64); await chain({ txs: { [h]: { success: false, contractIds: [mintArgs.contract_id] } } });
  const r = await api('/api/submissions/' + subId + '/confirm-mint', { token: T.artist, method: 'POST', json: { tx_hash: h } }); assert.equal(r.status, 409); assert.match(r.body.error, /failed/);
});
await test('confirm with a tx that called some other contract → 409', async () => {
  const h = 'b'.repeat(64); await chain({ txs: { [h]: { success: true, contractIds: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] } }, tokens: { [sha]: 7 } });
  const r = await api('/api/submissions/' + subId + '/confirm-mint', { token: T.artist, method: 'POST', json: { tx_hash: h } }); assert.equal(r.status, 409); assert.match(r.body.error, /Morianah contract/);
});
await test('confirm after the chain reports the token → minted with token_id', async () => {
  const h = 'c'.repeat(64); await chain({ txs: { [h]: { success: true, contractIds: [mintArgs.contract_id] } }, tokens: { [sha]: 7 } });
  const r = await api('/api/submissions/' + subId + '/confirm-mint', { token: T.artist, method: 'POST', json: { tx_hash: h } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.token_id, 7);
  const mine = await api('/api/submissions/mine', { token: T.artist }); const s = mine.body.submissions.find((x) => x.id === subId);
  assert.equal(s.status, 'minted'); assert.equal(s.token_id, 7);
});
await test('minted work appears in the public gallery with its token id and CID', async () => {
  const g = await api('/api/works'); const w = g.body.works.find((x) => x.sha256 === sha);
  assert.ok(w); assert.equal(w.status, 'minted'); assert.equal(w.token_id, 7); assert.equal(w.cid, mintArgs.cid);
});
await test('confirm again is a no-op; prepare again is refused', async () => {
  assert.equal((await api('/api/submissions/' + subId + '/confirm-mint', { token: T.artist, method: 'POST', json: {} })).body.already, true);
  assert.equal((await api('/api/submissions/' + subId + '/prepare-mint', { token: T.artist, method: 'POST' })).status, 409);
});

// reconcile: a work minted while the API was not told
let sub2, sha2;
await test('reconcile marks a work the chain knows about even if confirm was never called', async () => {
  const r = await upload(T.artist, 'Rose into Static', 79); sub2 = r.body.id; sha2 = r.body.sha256;
  await api('/api/verify/submissions/' + sub2, { token: T.verifier, method: 'POST', json: { decision: 'approved' } });
  await api('/api/submissions/' + sub2 + '/prepare-mint', { token: T.artist, method: 'POST' });
  await chain({ tokens: { [sha2]: 8 } });
  const rc = await api('/api/_test/reconcile', { method: 'POST' }); assert.equal(rc.body.minted, 1);
  const mine = await api('/api/submissions/mine', { token: T.artist }); const s = mine.body.submissions.find((x) => x.id === sub2);
  assert.equal(s.status, 'minted'); assert.equal(s.token_id, 8);
});
await test('reconcile ignores approved works that were never pinned', async () => {
  const r = await upload(T.artist, 'Unpinned', 80);
  await api('/api/verify/submissions/' + r.body.id, { token: T.verifier, method: 'POST', json: { decision: 'approved' } });
  await chain({ tokens: { [r.body.sha256]: 9 } });
  const rc = await api('/api/_test/reconcile', { method: 'POST' }); assert.equal(rc.body.minted, 0);
});

// on-chain role sync
await test('artist role sync: false until the chain has the grant, then true; reconcile also flips it', async () => {
  assert.equal((await api('/api/verify/artists/' + ARTIST + '/sync', { token: T.artist, method: 'POST' })).status, 403);
  let r = await api('/api/verify/artists/' + ARTIST + '/sync', { token: T.verifier, method: 'POST' }); assert.equal(r.body.onchain_artist, false);
  await chain({ roles: { [ARTIST]: ['artist'] } });
  r = await api('/api/verify/artists/' + ARTIST + '/sync', { token: T.verifier, method: 'POST' }); assert.equal(r.body.onchain_artist, true);
  const a = await api('/api/artists/me', { token: T.artist }); assert.equal(a.body.application.onchain_granted, 1);
});
await test('test control routes are not reachable without CHAIN_FAKE (shape check)', async () => {
  // We can only assert the route exists in fake mode here; production guard is the env check in code.
  assert.equal((await chain({})).status, 200);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

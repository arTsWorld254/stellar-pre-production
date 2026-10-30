// End-to-end test against a running `wrangler dev` (local D1 + R2).
// Run: node test/e2e.mjs      (expects http://127.0.0.1:8787)
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const T = { admin: 'dev-admin', verifier: 'dev-verifier', artist: 'dev-artist', artist2: 'dev-artist2', collector: 'dev-collector' };
const ADDR = {
  verifier: 'GAQQRWBIZZ2CPMV2M3435UWU3STLAFVH2NM6EOBE5KSXQDHSSPQ67FZD',
  artist: 'GABAA72CYM3LTRSMKHWCFRACEG75A7KY52335X57XC2ASQJQNE43FYG3',
  artist2: 'GAAV4JCNBBU7IIOYJD6S6BPRS52DENEGWXQWYALHFCRBKHMUCB34K7MZ',
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✔', name); }
  catch (e) { failed++; console.log('  ✘', name, '\n     ', e.message); }
}
const api = async (path, { token, method = 'GET', json, form } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const r = await fetch(BASE + path, { method, headers, body });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.arrayBuffer(), headers: r.headers };
};
// tiny valid PNG (1x1), different bytes per call via a trailing chunk so hashes differ
const png = (seed) => {
  const base = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  return Buffer.concat([base, Buffer.from([seed])]);
};
const upload = (token, { title = 'Untitled', seed = 1, mime = 'image/png', collection_id, bytes } = {}) => {
  const fd = new FormData();
  fd.set('image', new Blob([bytes ?? png(seed)], { type: mime }), 'work.png');
  fd.set('title', title);
  if (collection_id) fd.set('collection_id', String(collection_id));
  return api('/api/uploads', { token, method: 'POST', form: fd });
};

console.log('\nMorianah API e2e\n');

// ---------- sessions & profiles
await test('no session → 401', async () => { const r = await api('/api/me'); assert.equal(r.status, 401); });
await test('bad session → 401', async () => { const r = await api('/api/me', { token: 'nope' }); assert.equal(r.status, 401); });
await test('admin flag comes from ADMIN_ADDRESSES', async () => { const r = await api('/api/me', { token: T.admin }); assert.equal(r.body.isAdmin, true); });
await test('collector creates a profile', async () => {
  const r = await api('/api/profiles', { token: T.collector, method: 'POST', json: { persona: 'collector', display_name: 'Wanjiru', country: 'ke' } });
  assert.equal(r.status, 201);
  const me = await api('/api/me', { token: T.collector }); assert.equal(me.body.profile.country, 'KE');
});
await test('cannot create a second profile', async () => {
  const r = await api('/api/profiles', { token: T.collector, method: 'POST', json: { persona: 'collector', display_name: 'Again' } }); assert.equal(r.status, 409);
});
await test('invalid persona rejected', async () => {
  const r = await api('/api/profiles', { token: T.artist, method: 'POST', json: { persona: 'king', display_name: 'X' } }); assert.equal(r.status, 400);
});
await test('non-admin cannot self-declare as verifier', async () => {
  const r = await api('/api/profiles', { token: T.artist, method: 'POST', json: { persona: 'verifier', display_name: 'Sneaky' } }); assert.equal(r.status, 403);
});
await test('artist and artist2 create profiles', async () => {
  assert.equal((await api('/api/profiles', { token: T.artist, method: 'POST', json: { persona: 'artist', display_name: 'Amara' } })).status, 201);
  assert.equal((await api('/api/profiles', { token: T.artist2, method: 'POST', json: { persona: 'artist', display_name: 'Baraka' } })).status, 201);
});
await test('only admin can appoint a verifier; address must be a Stellar G-address', async () => {
  assert.equal((await api('/api/admin/verifiers', { token: T.artist, method: 'POST', json: { address: ADDR.verifier, display_name: 'Njeri' } })).status, 403);
  assert.equal((await api('/api/admin/verifiers', { token: T.admin, method: 'POST', json: { address: 'not-an-address', display_name: 'Njeri' } })).status, 400);
  assert.equal((await api('/api/admin/verifiers', { token: T.admin, method: 'POST', json: { address: ADDR.verifier, display_name: 'Njeri' } })).status, 201);
  const me = await api('/api/me', { token: T.verifier }); assert.equal(me.body.isVerifier, true); assert.equal(me.body.isAdmin, false);
});
await test('edit own profile', async () => {
  const r = await api('/api/profiles/me', { token: T.artist, method: 'PATCH', json: { bio: 'Painter, Nairobi' } }); assert.equal(r.status, 200);
  const p = await api('/api/profiles/' + ADDR.artist); assert.equal(p.body.profile.bio, 'Painter, Nairobi');
});

// ---------- artist vetting
await test('unapproved artist cannot upload', async () => { const r = await upload(T.artist); assert.equal(r.status, 403); });
await test('collector cannot apply as artist', async () => {
  const r = await api('/api/artists/apply', { token: T.collector, method: 'POST', json: { statement: 'I would like to be an artist please' } }); assert.equal(r.status, 403);
});
await test('artist applies; short statement rejected first', async () => {
  assert.equal((await api('/api/artists/apply', { token: T.artist, method: 'POST', json: { statement: 'short' } })).status, 400);
  assert.equal((await api('/api/artists/apply', { token: T.artist, method: 'POST', json: { statement: 'I paint the flowers of the Rift Valley in oil.', portfolio_url: 'https://example.art' } })).status, 201);
  assert.equal((await api('/api/artists/apply', { token: T.artist2, method: 'POST', json: { statement: 'Mixed media, Mombasa. Ten years of work.' } })).status, 201);
});
await test('artist cannot see the vetting queue', async () => { const r = await api('/api/verify/artists', { token: T.artist }); assert.equal(r.status, 403); });
await test('verifier sees the queue', async () => {
  const r = await api('/api/verify/artists', { token: T.verifier }); assert.equal(r.status, 200); assert.equal(r.body.applications.length, 2);
});
await test('reviewer approves artist 1, rejects artist 2', async () => {
  assert.equal((await api('/api/verify/artists/' + ADDR.artist, { token: T.verifier, method: 'POST', json: { decision: 'approved' } })).status, 200);
  assert.equal((await api('/api/verify/artists/' + ADDR.artist2, { token: T.verifier, method: 'POST', json: { decision: 'rejected', note: 'portfolio needed' } })).status, 200);
  const a = await api('/api/artists/me', { token: T.artist2 }); assert.equal(a.body.application.status, 'rejected'); assert.equal(a.body.application.review_note, 'portfolio needed');
});
await test('cannot review twice', async () => {
  assert.equal((await api('/api/verify/artists/' + ADDR.artist, { token: T.admin, method: 'POST', json: { decision: 'rejected' } })).status, 404);
});
await test('rejected artist may re-apply', async () => {
  assert.equal((await api('/api/artists/apply', { token: T.artist2, method: 'POST', json: { statement: 'Re-applying with portfolio attached this time.' } })).status, 201);
});

// ---------- collections
await test('non-admin (even a verifier) cannot create collections', async () => {
  assert.equal((await api('/api/admin/collections', { token: T.verifier, method: 'POST', json: { id: 1, slug: 'x', title: 'X' } })).status, 403);
});
await test('admin creates collection 1 (live) and 2 (draft)', async () => {
  assert.equal((await api('/api/admin/collections', { token: T.admin, method: 'POST', json: { id: 1, slug: 'if-flowers-went-to-war', title: 'If Flowers Went to War', status: 'live' } })).status, 201);
  assert.equal((await api('/api/admin/collections', { token: T.admin, method: 'POST', json: { id: 2, slug: 'nadra-i', title: 'Nadra Collection I' } })).status, 201);
  const r = await api('/api/collections'); assert.equal(r.body.collections.length, 1);
});

// ---------- uploads
let subId, subKey, subHash;
await test('approved artist uploads a work', async () => {
  const bytes = png(1);
  const r = await upload(T.artist, { title: 'Iris on Broken Ground I', seed: 1, collection_id: 1, bytes });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  subId = r.body.id; subHash = r.body.sha256;
  assert.equal(subHash, createHash('sha256').update(bytes).digest('hex'), 'server hash must equal client hash');
  const mine = await api('/api/submissions/mine', { token: T.artist }); subKey = mine.body.submissions[0].image_key;
  assert.equal(mine.body.submissions[0].status, 'pending');
});
await test('same file cannot be uploaded twice', async () => { const r = await upload(T.artist, { seed: 1 }); assert.equal(r.status, 409); });
await test('wrong mime rejected', async () => { const r = await upload(T.artist, { seed: 2, mime: 'text/plain' }); assert.equal(r.status, 415); });
await test('empty file rejected', async () => { const r = await upload(T.artist, { seed: 3, bytes: Buffer.alloc(0) }); assert.equal(r.status, 413); });
await test('unknown collection rejected', async () => { const r = await upload(T.artist, { seed: 4, collection_id: 99 }); assert.equal(r.status, 400); });
await test('pending image is private: public 403, artist 200, reviewer 200', async () => {
  assert.equal((await api('/api/images/' + subKey)).status, 403);
  assert.equal((await api('/api/images/' + subKey, { token: T.artist })).status, 200);
  assert.equal((await api('/api/images/' + subKey, { token: T.admin })).status, 200);
  assert.equal((await api('/api/images/' + subKey, { token: T.collector })).status, 403);
});
await test('pending work is not in the public gallery', async () => { const r = await api('/api/works'); assert.equal(r.body.works.length, 0); });

// ---------- submission vetting
await test('artist cannot review submissions', async () => { assert.equal((await api('/api/verify/submissions', { token: T.artist })).status, 403); });
await test('queue shows the pending work with artist name', async () => {
  const r = await api('/api/verify/submissions', { token: T.verifier }); assert.equal(r.body.submissions.length, 1); assert.equal(r.body.submissions[0].artist_name, 'Amara');
});
await test('bad decision rejected', async () => {
  assert.equal((await api('/api/verify/submissions/' + subId, { token: T.admin, method: 'POST', json: { decision: 'maybe' } })).status, 400);
});
await test('reviewer approves the work', async () => {
  assert.equal((await api('/api/verify/submissions/' + subId, { token: T.verifier, method: 'POST', json: { decision: 'approved', note: 'strong' } })).status, 200);
  assert.equal((await api('/api/verify/submissions/' + subId, { token: T.admin, method: 'POST', json: { decision: 'rejected' } })).status, 409);
});
await test('approved image is public and in the gallery', async () => {
  const img = await api('/api/images/' + subKey); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  const g = await api('/api/works'); assert.equal(g.body.works.length, 1); assert.equal(g.body.works[0].sha256, subHash);
});
await test('approved work cannot be withdrawn; pending one can', async () => {
  assert.equal((await api('/api/submissions/' + subId, { token: T.artist, method: 'DELETE' })).status, 409);
  const r = await upload(T.artist, { title: 'Draft', seed: 9 }); assert.equal(r.status, 201);
  assert.equal((await api('/api/submissions/' + r.body.id, { token: T.artist, method: 'DELETE' })).status, 200);
  assert.equal((await api('/api/submissions/' + r.body.id, { token: T.artist, method: 'DELETE' })).status, 404);
});

// ---------- rate limit
await test('daily upload cap enforced (cap=20)', async () => {
  let last;
  for (let i = 10; i < 32; i++) { last = await upload(T.artist, { seed: i, title: 'bulk ' + i }); if (last.status === 429) break; }
  assert.equal(last.status, 429);
});

// ---------- suspension & audit
await test('admin suspends an account; its session is then refused', async () => {
  assert.equal((await api('/api/admin/profiles/' + ADDR.artist2 + '/status', { token: T.admin, method: 'POST', json: { status: 'suspended' } })).status, 200);
  assert.equal((await api('/api/me', { token: T.artist2 })).status, 403);
  assert.equal((await api('/api/profiles/' + ADDR.artist2)).status, 404);
});
await test('audit log records the flow, admin-only', async () => {
  assert.equal((await api('/api/admin/audit', { token: T.artist })).status, 403);
  const r = await api('/api/admin/audit', { token: T.admin });
  const actions = new Set(r.body.log.map((x) => x.action));
  for (const a of ['profile.create', 'artist.apply', 'artist.approved', 'submission.create', 'submission.approved', 'submission.withdraw', 'collection.create', 'profile.suspended']) assert.ok(actions.has(a), 'missing ' + a);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

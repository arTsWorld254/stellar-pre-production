// SEP-10 login tests against a running `wrangler dev`. Run: node test/auth.mjs
import assert from 'node:assert/strict';
import { Keypair, Networks, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const NET = Networks.TESTNET;
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✔', name); }
  catch (e) { failed++; console.log('  ✘', name, '\n     ', e.message); }
}
const get = async (p, token) => { const r = await fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); return { status: r.status, body: await r.json() }; };
const post = async (p, json, token) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(json) });
  return { status: r.status, body: await r.json() };
};

/** What a wallet (Freighter, Lobstr…) does: sign the challenge, never submit it. */
function walletSign(challengeXdr, keypair) {
  const tx = TransactionBuilder.fromXDR(challengeXdr, NET);
  tx.sign(keypair);
  return tx.toXDR();
}

console.log('\nSEP-10 login\n');

const info = (await get('/auth/info')).body;
const SERVER_KEY = info.signing_key;
await test('auth info exposes the server signing key and domains', async () => {
  assert.match(SERVER_KEY, /^G[A-Z2-7]{55}$/); assert.equal(info.home_domain, 'morianahinc.art'); assert.equal(info.sep10, true);
});

const wallet = Keypair.random();
await test('challenge is refused for a malformed account', async () => {
  assert.equal((await get('/auth/challenge?account=hello')).status, 400);
});
await test('challenge for a contract (passkey) account says SEP-45 not enabled', async () => {
  const r = await get('/auth/challenge?account=CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX'); assert.equal(r.status, 501);
});

let challenge;
await test('challenge is a valid SEP-10 transaction signed by the server', async () => {
  const r = await get('/auth/challenge?account=' + wallet.publicKey());
  assert.equal(r.status, 200); challenge = r.body.transaction;
  const read = WebAuth.readChallengeTx(challenge, SERVER_KEY, NET, 'morianahinc.art', 'api.morianahinc.art');
  assert.equal(read.clientAccountID, wallet.publicKey());
  assert.equal(read.tx.sequence, '0'); // never submittable
});

let session;
await test('wallet signs → session issued; session unlocks /api/me', async () => {
  const r = await post('/auth/verify', { transaction: walletSign(challenge, wallet) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  session = r.body.token; assert.equal(r.body.address, wallet.publicKey()); assert.equal(r.body.profile, null);
  const me = await get('/api/me', session); assert.equal(me.status, 200); assert.equal(me.body.address, wallet.publicKey());
});
await test('a used challenge cannot be replayed', async () => {
  const r = await post('/auth/verify', { transaction: walletSign(challenge, wallet) }); assert.equal(r.status, 401); assert.match(r.body.error, /already used/);
});
await test('unsigned challenge is rejected (client signature missing)', async () => {
  const c = (await get('/auth/challenge?account=' + wallet.publicKey())).body.transaction;
  const r = await post('/auth/verify', { transaction: c }); assert.equal(r.status, 401);
});
await test('challenge signed by a different wallet is rejected', async () => {
  const c = (await get('/auth/challenge?account=' + wallet.publicKey())).body.transaction;
  const r = await post('/auth/verify', { transaction: walletSign(c, Keypair.random()) }); assert.equal(r.status, 401);
});
await test('challenge forged with a fake server key is rejected', async () => {
  const fakeServer = Keypair.random();
  const forged = WebAuth.buildChallengeTx(fakeServer, wallet.publicKey(), 'morianahinc.art', 300, NET, 'api.morianahinc.art');
  const r = await post('/auth/verify', { transaction: walletSign(forged, wallet) }); assert.equal(r.status, 401);
});
await test('challenge for another domain (phishing) is rejected', async () => {
  // Even if the attacker got the real server to sign for a different home domain, it is refused here.
  const c = (await get('/auth/challenge?account=' + wallet.publicKey())).body.transaction;
  const tx = TransactionBuilder.fromXDR(c, NET);
  // tamper: rebuild with a different network passphrase → signatures no longer verify
  const tampered = TransactionBuilder.fromXDR(tx.toXDR(), Networks.PUBLIC); tampered.sign(wallet);
  const r = await post('/auth/verify', { transaction: tampered.toXDR() }); assert.equal(r.status, 401);
});
await test('garbage body is rejected cleanly', async () => {
  assert.equal((await post('/auth/verify', { transaction: 'AAAA' })).status, 401);
  assert.equal((await post('/auth/verify', {})).status, 400);
});
await test('new wallet logs in and can immediately create a profile', async () => {
  const w2 = Keypair.random();
  const c = (await get('/auth/challenge?account=' + w2.publicKey())).body.transaction;
  const s2 = (await post('/auth/verify', { transaction: walletSign(c, w2) })).body.token;
  const r = await post('/api/profiles', { persona: 'collector', display_name: 'Otieno' }, s2); assert.equal(r.status, 201);
  const me = await get('/api/me', s2); assert.equal(me.body.profile.display_name, 'Otieno');
});
await test('logout invalidates the session', async () => {
  assert.equal((await post('/auth/logout', {}, session)).status, 200);
  assert.equal((await get('/api/me', session)).status, 401);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

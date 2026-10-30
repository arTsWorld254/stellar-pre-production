/**
 * Login for Morianah — turns a Stellar wallet signature into a session row.
 *
 *   SEP-10  (G… accounts: Freighter, Lobstr, Albedo, any keypair)   — implemented
 *   SEP-45  (C… passkey smart wallets)                               — route reserved; needs RPC
 *
 * Flow (SEP-10):
 *   1. GET  /auth/challenge?account=G…  → server-signed challenge transaction (XDR)
 *   2. wallet signs it (never submitted to the network)
 *   3. POST /auth/verify {transaction}  → server verifies both signatures, issues a session
 *
 * Replay protection: every challenge carries a random nonce; its hash is stored
 * and may be redeemed once. Challenges expire after CHALLENGE_TTL seconds.
 */
import { Hono } from 'hono';
import { Keypair, Networks, StrKey, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import type { Env } from './index';

export type AuthEnv = Env & {
  SERVER_SIGNING_SECRET: string;   // S… secret of the server's SEP-10 signing key (wrangler secret)
  HOME_DOMAIN: string;             // e.g. morianahinc.art
  WEB_AUTH_DOMAIN: string;         // e.g. api.morianahinc.art
  NETWORK_PASSPHRASE?: string;     // defaults to TESTNET
};

const CHALLENGE_TTL = 300;         // seconds a challenge is valid
const SESSION_TTL = 24 * 3600;     // seconds a session lives
const now = () => Math.floor(Date.now() / 1000);

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
function randomToken() { return hex(crypto.getRandomValues(new Uint8Array(32))); }

export function networkPassphrase(env: AuthEnv) { return env.NETWORK_PASSPHRASE || Networks.TESTNET; }

export const auth = new Hono<{ Bindings: AuthEnv }>();

/** Public key the wallet should expect the challenge to be signed with (also goes in stellar.toml SIGNING_KEY). */
auth.get('/auth/info', (c) => {
  const kp = Keypair.fromSecret(c.env.SERVER_SIGNING_SECRET);
  return c.json({ ok: true, signing_key: kp.publicKey(), home_domain: c.env.HOME_DOMAIN, web_auth_domain: c.env.WEB_AUTH_DOMAIN, network_passphrase: networkPassphrase(c.env), sep10: true, sep45: false });
});

/** Step 1 — challenge. */
auth.get('/auth/challenge', async (c) => {
  const account = c.req.query('account') || '';
  if (StrKey.isValidContract(account)) {
    return c.json({ ok: false, error: 'passkey (contract) accounts use SEP-45, which is not enabled yet' }, 501);
  }
  if (!StrKey.isValidEd25519PublicKey(account)) return c.json({ ok: false, error: 'account must be a Stellar G… address' }, 400);

  const server = Keypair.fromSecret(c.env.SERVER_SIGNING_SECRET);
  const transaction = WebAuth.buildChallengeTx(server, account, c.env.HOME_DOMAIN, CHALLENGE_TTL, networkPassphrase(c.env), c.env.WEB_AUTH_DOMAIN);

  // Remember the challenge so it can be redeemed exactly once. Keyed on the
  // transaction hash (the signing payload), which does not change when the
  // wallet adds its signature.
  const txHash = (TransactionBuilder.fromXDR(transaction, networkPassphrase(c.env)).hash() as unknown as Uint8Array).reduce((a, b) => a + b.toString(16).padStart(2, '0'), '');
  await c.env.DB.prepare('INSERT INTO auth_challenges (hash, account, expires_at) VALUES (?,?,?)')
    .bind(txHash, account, now() + CHALLENGE_TTL).run();

  return c.json({ ok: true, transaction, network_passphrase: networkPassphrase(c.env) });
});

/** Step 3 — verify the wallet-signed challenge and issue a session. */
auth.post('/auth/verify', async (c) => {
  const body = await c.req.json<{ transaction?: string }>().catch(() => null);
  const signed = body?.transaction;
  if (!signed || typeof signed !== 'string') return c.json({ ok: false, error: 'transaction (signed challenge XDR) required' }, 400);

  const server = Keypair.fromSecret(c.env.SERVER_SIGNING_SECRET);
  const passphrase = networkPassphrase(c.env);

  // 1. Structure + server signature + time bounds + domains (throws InvalidChallengeError on any mismatch)
  let clientAccountID: string;
  try {
    const read = WebAuth.readChallengeTx(signed, server.publicKey(), passphrase, c.env.HOME_DOMAIN, c.env.WEB_AUTH_DOMAIN);
    clientAccountID = read.clientAccountID;
    // 2. The client's signature must be present and valid for the account it claims
    WebAuth.verifyChallengeTxSigners(signed, server.publicKey(), passphrase, [clientAccountID], c.env.HOME_DOMAIN, c.env.WEB_AUTH_DOMAIN);
  } catch (e: any) {
    return c.json({ ok: false, error: 'invalid challenge: ' + (e?.message || 'rejected') }, 401);
  }

  // 3. Single use: the challenge we issued must exist, match the account, and be unexpired.
  const unsignedHash = (TransactionBuilder.fromXDR(signed, passphrase).hash() as unknown as Uint8Array).reduce((a, b) => a + b.toString(16).padStart(2, '0'), '');
  const row = await c.env.DB.prepare('SELECT account, expires_at, used_at FROM auth_challenges WHERE hash = ?')
    .bind(unsignedHash).first<{ account: string; expires_at: number; used_at: number | null }>();
  if (!row) return c.json({ ok: false, error: 'unknown challenge' }, 401);
  if (row.account !== clientAccountID) return c.json({ ok: false, error: 'challenge was issued to a different account' }, 401);
  if (row.used_at) return c.json({ ok: false, error: 'challenge already used' }, 401);
  if (row.expires_at < now()) return c.json({ ok: false, error: 'challenge expired' }, 401);
  await c.env.DB.prepare('UPDATE auth_challenges SET used_at = ? WHERE hash = ?').bind(now(), unsignedHash).run();

  // 4. Issue the session
  const token = randomToken();
  const expires_at = now() + SESSION_TTL;
  await c.env.DB.prepare('INSERT INTO sessions (token, address, expires_at) VALUES (?,?,?)').bind(token, clientAccountID, expires_at).run();
  await c.env.DB.prepare('INSERT INTO audit_log (at, actor, action, subject) VALUES (?,?,?,?)').bind(now(), clientAccountID, 'auth.login', 'sep10').run();

  const profile = await c.env.DB.prepare('SELECT persona, display_name FROM profiles WHERE address = ?').bind(clientAccountID).first();
  return c.json({ ok: true, token, address: clientAccountID, expires_at, profile: profile ?? null });
});

auth.post('/auth/logout', async (c) => {
  const h = c.req.header('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return c.json({ ok: true });
});

/** Housekeeping: drop expired sessions and challenges. Called from the cron. */
export async function sweepAuth(env: AuthEnv) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(t - 3600),
  ]);
}

/**
 * Step 4 — the mint pipeline. Joins the API (step 2) to the contract (step 1).
 *
 *   artist                                 API                                  Stellar
 *   ──────                                 ───                                  ───────
 *   POST /api/submissions/:id/prepare-mint → pin image + metadata to IPFS,
 *                                            store cid, return {contract, cid, sha256, …}
 *   wallet builds + signs mint_work(...)  ──────────────────────────────────────▶ mint
 *   POST /api/submissions/:id/confirm-mint → read chain: token_by_hash(sha256)
 *                                            → status='minted', token_id
 *   (hourly cron)                            reconcile: any approved+pinned work the
 *                                            chain already knows about → minted
 *
 * The API holds no signing key. It cannot mint, cannot grant roles, cannot move tokens.
 */
import { Hono } from 'hono';
import type { Env } from './index';
import { type ChainReader, RpcChainReader, tokenByHash, hasRole, type ChainEnv } from './chain';
import { pinnerFor, buildMetadata, type IpfsEnv } from './ipfs';

export type MintEnv = Env & ChainEnv & IpfsEnv;
type Caller = { address: string; profile: any; isAdmin: boolean; isVerifier: boolean };

const now = () => Math.floor(Date.now() / 1000);
const bad = (c: any, status: number, error: string) => c.json({ ok: false, error }, status);

/** Test seam: tests set a fake reader; production builds the RPC one from env. */
let readerOverride: ChainReader | null = null;
export function setChainReaderForTests(r: ChainReader | null) { readerOverride = r; }
export function chainReader(env: MintEnv): ChainReader | null {
  if (readerOverride) return readerOverride;
  if ((env as any).CHAIN_FAKE === '1') return fake;      // local dev / tests only
  if (!env.CONTRACT_ID || !env.RPC_URL) return null;
  return new RpcChainReader(env);
}

/** In-memory stand-in for the chain. Only reachable when CHAIN_FAKE=1 (never set in production). */
class FakeChainReader implements ChainReader {
  tokens = new Map<string, number>();                 // sha256 hex -> token id
  roles = new Map<string, Set<string>>();             // address -> roles
  txs = new Map<string, { success: boolean; contractIds: string[] }>();
  async read(fn: string, a: any[]): Promise<unknown> {
    const { scValToNative, Address } = await import('@stellar/stellar-sdk');
    if (fn === 'token_by_hash') { const hex = Buffer.from(scValToNative(a[0]) as Uint8Array).toString('hex'); return this.tokens.has(hex) ? this.tokens.get(hex) : null; }
    if (fn === 'has_role') { const acc = Address.fromScVal(a[0]).toString(); const role = String(scValToNative(a[1])); return this.roles.get(acc)?.has(role) ? 0 : null; }
    throw new Error('fake: unknown fn ' + fn);
  }
  async tx(hash: string) { const t = this.txs.get(hash); return t ? { found: true, ...t } : { found: false, success: false, contractIds: [] }; }
}
const fake = new FakeChainReader();

/** Test control surface for the fake chain (CHAIN_FAKE=1 only). */
function mintTestRoutes() {
  mint.post('/api/_test/chain', async (c) => {
    if ((c.env as any).CHAIN_FAKE !== '1') return bad(c, 404, 'no such route');
    const b = await c.req.json<{ tokens?: Record<string, number>; roles?: Record<string, string[]>; txs?: Record<string, { success: boolean; contractIds: string[] }>; reset?: boolean }>();
    if (b.reset) { fake.tokens.clear(); fake.roles.clear(); fake.txs.clear(); }
    for (const [k, v] of Object.entries(b.tokens || {})) fake.tokens.set(k.toLowerCase(), v);
    for (const [k, v] of Object.entries(b.roles || {})) fake.roles.set(k, new Set(v));
    for (const [k, v] of Object.entries(b.txs || {})) fake.txs.set(k.toLowerCase(), v);
    return c.json({ ok: true });
  });
  mint.post('/api/_test/reconcile', async (c) => {
    if ((c.env as any).CHAIN_FAKE !== '1') return bad(c, 404, 'no such route');
    return c.json({ ok: true, ...(await reconcileChain(c.env)) });
  });
}

export const mint = new Hono<{ Bindings: MintEnv; Variables: { caller: Caller } }>();
mintTestRoutes();

/** What the browser needs to build a mint transaction. */
mint.get('/api/chain/info', (c) => c.json({
  ok: true, contract_id: c.env.CONTRACT_ID || null, rpc_url: c.env.RPC_URL || null,
  network_passphrase: c.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  ipfs: pinnerFor(c.env).real ? 'pinata' : 'dev-placeholder',
}));

/** Artist: pin an approved submission to IPFS and get the exact mint arguments. Idempotent. */
mint.post('/api/submissions/:id/prepare-mint', async (c) => {
  const k = c.get('caller');
  const id = c.req.param('id');
  const sub = await c.env.DB.prepare(
    `SELECT s.*, p.display_name AS artist_name, col.title AS collection_title
       FROM submissions s JOIN profiles p ON p.address = s.artist LEFT JOIN collections col ON col.id = s.collection_id
      WHERE s.id = ?`).bind(id).first<any>();
  if (!sub) return bad(c, 404, 'not found');
  if (sub.artist !== k.address) return bad(c, 403, 'not your submission');
  if (sub.status === 'minted') return bad(c, 409, 'already minted');
  if (sub.status !== 'approved') return bad(c, 409, `submission is ${sub.status}; it must be approved first`);
  if (!c.env.CONTRACT_ID) return bad(c, 503, 'contract not configured');

  let cid: string = sub.cid;
  if (!cid) {
    const obj = await c.env.IMAGES.get(sub.image_key);
    if (!obj) return bad(c, 500, 'image missing from storage');
    const { pinner } = pinnerFor(c.env);
    const imageCid = await pinner.pinFile(await obj.arrayBuffer(), `${sub.sha256}.${sub.mime.split('/')[1]}`, sub.mime);
    const meta = buildMetadata({
      title: sub.title, description: sub.description, imageCid, mime: sub.mime, sha256: sub.sha256,
      artist: sub.artist, artistName: sub.artist_name, collectionId: sub.collection_id, collectionTitle: sub.collection_title,
    });
    cid = await pinner.pinJson(meta, `${sub.sha256}.json`);
    await c.env.DB.prepare('UPDATE submissions SET cid = ?, image_cid = ? WHERE id = ? AND cid IS NULL').bind(cid, imageCid, id).run();
    await c.env.DB.prepare('INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?,?,?,?,?)')
      .bind(now(), k.address, 'submission.pinned', id, JSON.stringify({ cid, imageCid })).run();
  }
  return c.json({
    ok: true,
    mint: {
      contract_id: c.env.CONTRACT_ID, rpc_url: c.env.RPC_URL, network_passphrase: c.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
      fn: 'mint_work', artist: sub.artist, collection: sub.collection_id ?? 0, cid, sha256: sub.sha256,
    },
  });
});

/** Artist: after the wallet submitted the transaction, confirm against the chain. */
mint.post('/api/submissions/:id/confirm-mint', async (c) => {
  const k = c.get('caller');
  const id = c.req.param('id');
  const body = await c.req.json<{ tx_hash?: string }>().catch(() => ({} as any));
  const sub = await c.env.DB.prepare('SELECT artist, status, sha256, cid FROM submissions WHERE id = ?').bind(id).first<any>();
  if (!sub) return bad(c, 404, 'not found');
  if (sub.artist !== k.address && !k.isVerifier) return bad(c, 403, 'not your submission');
  if (sub.status === 'minted') return c.json({ ok: true, status: 'minted', already: true });
  if (sub.status !== 'approved' || !sub.cid) return bad(c, 409, 'prepare-mint first');
  const reader = chainReader(c.env);
  if (!reader) return bad(c, 503, 'chain not configured');

  // Optional: if a tx hash is given, insist it succeeded and touched our contract.
  if (body.tx_hash) {
    if (!/^[0-9a-f]{64}$/i.test(body.tx_hash)) return bad(c, 400, 'tx_hash must be 64 hex chars');
    const t = await reader.tx(body.tx_hash);
    if (!t.found) return bad(c, 404, 'transaction not found yet; try again in a few seconds');
    if (!t.success) return bad(c, 409, 'transaction failed on chain');
    if (t.contractIds.length && !t.contractIds.includes(c.env.CONTRACT_ID)) return bad(c, 409, 'transaction did not call the Morianah contract');
  }
  // Source of truth: does the contract know this file hash?
  const tokenId = await tokenByHash(reader, sub.sha256);
  if (tokenId === null) return bad(c, 409, 'the chain has no token for this file yet');
  await markMinted(c.env, id, tokenId, body.tx_hash ?? null, k.address);
  return c.json({ ok: true, status: 'minted', token_id: tokenId });
});

async function markMinted(env: MintEnv, id: string, tokenId: number, txHash: string | null, actor: string) {
  await env.DB.prepare("UPDATE submissions SET status='minted', token_id=?, mint_tx=?, minted_at=? WHERE id=? AND status<>'minted'")
    .bind(tokenId, txHash, now(), id).run();
  await env.DB.prepare('INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?,?,?,?,?)')
    .bind(now(), actor, 'submission.minted', id, JSON.stringify({ token_id: tokenId, tx: txHash })).run();
}

/** Verifier/admin: has the on-chain artist role actually been granted? Flips the flag. */
mint.post('/api/verify/artists/:address/sync', async (c) => {
  const k = c.get('caller');
  if (!k.isVerifier) return bad(c, 403, 'verifier role required');
  const reader = chainReader(c.env);
  if (!reader) return bad(c, 503, 'chain not configured');
  const address = c.req.param('address');
  const on = await hasRole(reader, address, 'artist');
  await c.env.DB.prepare('UPDATE artist_applications SET onchain_granted = ? WHERE address = ?').bind(on ? 1 : 0, address).run();
  return c.json({ ok: true, address, onchain_artist: on });
});

/** Cron: reconcile anything the chain knows that the DB does not. Safe to run any time. */
export async function reconcileChain(env: MintEnv) {
  const reader = chainReader(env);
  if (!reader) return { skipped: true };
  let minted = 0, granted = 0;
  const { results: pending } = await env.DB.prepare("SELECT id, sha256 FROM submissions WHERE status='approved' AND cid IS NOT NULL LIMIT 100").all<{ id: string; sha256: string }>();
  for (const s of pending) {
    try { const t = await tokenByHash(reader, s.sha256); if (t !== null) { await markMinted(env, s.id, t, null, 'cron'); minted++; } } catch { /* next */ }
  }
  const { results: apps } = await env.DB.prepare("SELECT address FROM artist_applications WHERE status='approved' AND onchain_granted=0 LIMIT 100").all<{ address: string }>();
  for (const a of apps) {
    try { if (await hasRole(reader, a.address, 'artist')) { await env.DB.prepare('UPDATE artist_applications SET onchain_granted=1 WHERE address=?').bind(a.address).run(); granted++; } } catch { /* next */ }
  }
  return { minted, granted };
}

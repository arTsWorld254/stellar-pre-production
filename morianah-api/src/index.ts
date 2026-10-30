/**
 * Morianah API — Cloudflare Worker (Hono) + D1 + R2.
 *
 * Step 2 of the build path: profiles for the four personas, artist
 * applications, artwork uploads, and the verifier vetting queue.
 *
 * Auth seam: every protected route expects `Authorization: Bearer <session>`.
 * Sessions are created by SEP-10 login (step 3). Until then they are seeded.
 *
 * Who may do what
 *   anyone with a session  — create/edit own profile, read public data
 *   artist (approved)      — upload works, see own submissions
 *   verifier               — review artist applications and submissions
 *   admin (ADMIN_ADDRESSES)— everything a verifier can, plus collections and suspensions
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth as authRoutes, sweepAuth, type AuthEnv } from './auth';
import { mint as mintRoutes, reconcileChain, chainReader, type MintEnv } from './mint';
import { hasRole } from './chain';

export type Env = {
  DB: D1Database;
  IMAGES: R2Bucket;
  ADMIN_ADDRESSES: string;
  UPLOAD_DAILY_CAP: string;
  MAX_IMAGE_BYTES: string;
  TURNSTILE_SECRET?: string;
};

type Persona = 'artist' | 'verifier' | 'curator' | 'collector';
type Profile = {
  address: string; persona: Persona; display_name: string; bio: string | null; country: string | null;
  avatar_key: string | null; status: 'active' | 'suspended'; created_at: number; updated_at: number;
};
type Caller = { address: string; profile: Profile | null; isAdmin: boolean; isVerifier: boolean };

type Vars = { caller: Caller };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('*', cors({ origin: (o) => o ?? '*', allowHeaders: ['Authorization', 'Content-Type'] }));

// ------------------------------------------------------------------ helpers

const now = () => Math.floor(Date.now() / 1000);
const STELLAR_ADDR = /^G[A-Z2-7]{55}$/;
const PERSONAS: Persona[] = ['artist', 'verifier', 'curator', 'collector'];
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const bad = (c: any, status: number, error: string) => c.json({ ok: false, error }, status);

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function audit(env: Env, actor: string, action: string, subject?: string, detail?: unknown) {
  await env.DB.prepare('INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?,?,?,?,?)')
    .bind(now(), actor, action, subject ?? null, detail ? JSON.stringify(detail) : null).run();
}

async function loadCaller(env: Env, token: string): Promise<Caller | null> {
  const s = await env.DB.prepare('SELECT address FROM sessions WHERE token = ? AND expires_at > ?')
    .bind(token, now()).first<{ address: string }>();
  if (!s) return null;
  const profile = await env.DB.prepare('SELECT * FROM profiles WHERE address = ?').bind(s.address).first<Profile>();
  const admins = (env.ADMIN_ADDRESSES || '').split(',').map((a) => a.trim()).filter(Boolean);
  const isAdmin = admins.includes(s.address);
  const isVerifier = isAdmin || (profile?.persona === 'verifier' && profile.status === 'active');
  return { address: s.address, profile, isAdmin, isVerifier };
}

/** Require a valid session. */
const auth = async (c: any, next: any) => {
  const h = c.req.header('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return bad(c, 401, 'missing session');
  const caller = await loadCaller(c.env, token);
  if (!caller) return bad(c, 401, 'invalid or expired session');
  if (caller.profile?.status === 'suspended') return bad(c, 403, 'account suspended');
  c.set('caller', caller);
  await next();
};
const requireVerifier = async (c: any, next: any) => {
  if (!c.get('caller').isVerifier) return bad(c, 403, 'verifier role required');
  await next();
};
const requireAdmin = async (c: any, next: any) => {
  if (!c.get('caller').isAdmin) return bad(c, 403, 'admin required');
  await next();
};

async function isApprovedArtist(env: Env, address: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT 1 FROM artist_applications WHERE address = ? AND status = 'approved'")
    .bind(address).first();
  return !!r;
}

async function verifyTurnstile(env: Env, token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true; // not configured (dev) → skip
  if (!token) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip) body.set('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const j = (await r.json()) as { success: boolean };
  return !!j.success;
}

// ------------------------------------------------------------------ public

app.get('/api/health', (c) => c.json({ ok: true, at: now() }));

app.get('/api/collections', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, slug, title, description, cover_key, status FROM collections WHERE status = 'live' ORDER BY id").all();
  return c.json({ ok: true, collections: results });
});

app.get('/api/profiles/:address', async (c) => {
  const p = await c.env.DB.prepare('SELECT address, persona, display_name, bio, country, avatar_key, created_at FROM profiles WHERE address = ? AND status = ?')
    .bind(c.req.param('address'), 'active').first();
  if (!p) return bad(c, 404, 'not found');
  return c.json({ ok: true, profile: p });
});

/** Public gallery: approved or minted works only. */
app.get('/api/works', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.title, s.description, s.sha256, s.status, s.token_id, s.cid, s.collection_id, s.created_at,
            s.artist, p.display_name AS artist_name
       FROM submissions s JOIN profiles p ON p.address = s.artist
      WHERE s.status IN ('approved','minted') ORDER BY s.created_at DESC LIMIT 100`).all();
  return c.json({ ok: true, works: results });
});

/** Serve an image. Pending/rejected files are visible only to the artist and verifiers. */
app.get('/api/images/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const sub = await c.env.DB.prepare('SELECT artist, status FROM submissions WHERE image_key = ?').bind(key).first<{ artist: string; status: string }>();
  if (!sub) return bad(c, 404, 'not found');
  if (!['approved', 'minted'].includes(sub.status)) {
    const h = c.req.header('Authorization') || '';
    const caller = h.startsWith('Bearer ') ? await loadCaller(c.env, h.slice(7)) : null;
    if (!caller || (caller.address !== sub.artist && !caller.isVerifier)) return bad(c, 403, 'not public');
  }
  const obj = await c.env.IMAGES.get(key);
  if (!obj) return bad(c, 404, 'file missing');
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' } });
});

// ------------------------------------------------------------------ profiles (own)

app.get('/api/me', auth, (c) => {
  const k = c.get('caller');
  return c.json({ ok: true, address: k.address, profile: k.profile, isAdmin: k.isAdmin, isVerifier: k.isVerifier });
});

app.post('/api/profiles', auth, async (c) => {
  const k = c.get('caller');
  if (k.profile) return bad(c, 409, 'profile exists; use PATCH /api/profiles/me');
  const b = await c.req.json<{ persona: Persona; display_name: string; bio?: string; country?: string }>().catch(() => null);
  if (!b || !PERSONAS.includes(b.persona)) return bad(c, 400, 'persona must be artist|verifier|curator|collector');
  if (b.persona === 'verifier' && !k.isAdmin) return bad(c, 403, 'verifier profiles are created by admins');
  const name = (b.display_name || '').trim();
  if (name.length < 2 || name.length > 60) return bad(c, 400, 'display_name 2–60 chars');
  const t = now();
  await c.env.DB.prepare('INSERT INTO profiles (address, persona, display_name, bio, country, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(k.address, b.persona, name, b.bio?.slice(0, 1000) ?? null, b.country?.toUpperCase().slice(0, 2) ?? null, 'active', t, t).run();
  await audit(c.env, k.address, 'profile.create', k.address, { persona: b.persona });
  return c.json({ ok: true }, 201);
});

app.patch('/api/profiles/me', auth, async (c) => {
  const k = c.get('caller');
  if (!k.profile) return bad(c, 404, 'no profile yet');
  const b = await c.req.json<{ display_name?: string; bio?: string; country?: string }>().catch(() => null);
  if (!b) return bad(c, 400, 'json body required');
  const name = b.display_name !== undefined ? b.display_name.trim() : k.profile.display_name;
  if (name.length < 2 || name.length > 60) return bad(c, 400, 'display_name 2–60 chars');
  await c.env.DB.prepare('UPDATE profiles SET display_name=?, bio=?, country=?, updated_at=? WHERE address=?')
    .bind(name, b.bio !== undefined ? b.bio.slice(0, 1000) : k.profile.bio, b.country !== undefined ? b.country.toUpperCase().slice(0, 2) : k.profile.country, now(), k.address).run();
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ artist vetting

app.post('/api/artists/apply', auth, async (c) => {
  const k = c.get('caller');
  if (k.profile?.persona !== 'artist') return bad(c, 403, 'artist profile required');
  const existing = await c.env.DB.prepare('SELECT status FROM artist_applications WHERE address = ?').bind(k.address).first<{ status: string }>();
  if (existing && existing.status !== 'rejected') return bad(c, 409, `application already ${existing.status}`);
  const b = await c.req.json<{ statement: string; portfolio_url?: string }>().catch(() => null);
  if (!b || (b.statement || '').trim().length < 20) return bad(c, 400, 'statement of at least 20 characters');
  await c.env.DB.prepare(
    `INSERT INTO artist_applications (address, statement, portfolio_url, status, created_at) VALUES (?,?,?,'pending',?)
     ON CONFLICT(address) DO UPDATE SET statement=excluded.statement, portfolio_url=excluded.portfolio_url, status='pending', reviewer=NULL, review_note=NULL, reviewed_at=NULL, created_at=excluded.created_at`)
    .bind(k.address, b.statement.trim().slice(0, 2000), b.portfolio_url?.slice(0, 300) ?? null, now()).run();
  await audit(c.env, k.address, 'artist.apply', k.address);
  return c.json({ ok: true, status: 'pending' }, 201);
});

app.get('/api/artists/me', auth, async (c) => {
  const k = c.get('caller');
  const a = await c.env.DB.prepare('SELECT status, review_note, reviewed_at, onchain_granted, created_at FROM artist_applications WHERE address = ?').bind(k.address).first();
  return c.json({ ok: true, application: a ?? null });
});

app.get('/api/verify/artists', auth, requireVerifier, async (c) => {
  const status = c.req.query('status') || 'pending';
  const { results } = await c.env.DB.prepare(
    `SELECT a.address, p.display_name, p.country, a.statement, a.portfolio_url, a.status, a.created_at, a.reviewer, a.review_note
       FROM artist_applications a JOIN profiles p ON p.address = a.address WHERE a.status = ? ORDER BY a.created_at ASC LIMIT 200`)
    .bind(status).all();
  return c.json({ ok: true, applications: results });
});

app.post('/api/verify/artists/:address', auth, requireVerifier, async (c) => {
  const k = c.get('caller');
  const address = c.req.param('address');
  if (address === k.address) return bad(c, 403, 'cannot review yourself');
  const b = await c.req.json<{ decision: 'approved' | 'rejected'; note?: string }>().catch(() => null);
  if (!b || !['approved', 'rejected'].includes(b.decision)) return bad(c, 400, 'decision must be approved|rejected');
  const r = await c.env.DB.prepare("UPDATE artist_applications SET status=?, reviewer=?, review_note=?, reviewed_at=? WHERE address=? AND status='pending'")
    .bind(b.decision, k.address, b.note?.slice(0, 1000) ?? null, now(), address).run();
  if (!r.meta.changes) return bad(c, 404, 'no pending application for that address');
  await audit(c.env, k.address, `artist.${b.decision}`, address, { note: b.note });
  // On approval the verifier must also sign the on-chain grant_role(address, "artist") transaction.
  // Step 3/4 wires that into the dashboard; the cron then flips onchain_granted.
  return c.json({ ok: true, status: b.decision, next: b.decision === 'approved' ? 'sign grant_role on chain' : null });
});

// ------------------------------------------------------------------ uploads (artists)

app.post('/api/uploads', auth, async (c) => {
  const k = c.get('caller');
  if (k.profile?.persona !== 'artist') return bad(c, 403, 'artist profile required');
  if (!(await isApprovedArtist(c.env, k.address))) return bad(c, 403, 'artist not yet approved');

  const form = await c.req.formData().catch(() => null);
  if (!form) return bad(c, 400, 'multipart/form-data required');
  const file = form.get('image');
  const title = String(form.get('title') || '').trim();
  const description = String(form.get('description') || '').trim();
  const collectionRaw = form.get('collection_id');
  const turnstile = form.get('turnstile') ? String(form.get('turnstile')) : undefined;

  if (!(await verifyTurnstile(c.env, turnstile, c.req.header('CF-Connecting-IP')))) return bad(c, 403, 'bot check failed');
  if (!(file instanceof File)) return bad(c, 400, 'image file required');
  if (!ALLOWED_MIME.has(file.type)) return bad(c, 415, 'image must be jpeg, png or webp');
  const maxBytes = Number(c.env.MAX_IMAGE_BYTES || 26214400);
  if (file.size === 0 || file.size > maxBytes) return bad(c, 413, `image must be 1 byte – ${maxBytes} bytes`);
  if (title.length < 1 || title.length > 120) return bad(c, 400, 'title 1–120 chars');

  let collection_id: number | null = null;
  if (collectionRaw) {
    collection_id = Number(collectionRaw);
    const col = await c.env.DB.prepare('SELECT id FROM collections WHERE id = ?').bind(collection_id).first();
    if (!col) return bad(c, 400, 'unknown collection');
  }

  // rate limit: per artist per 24h
  const cap = Number(c.env.UPLOAD_DAILY_CAP || 20);
  const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE artist = ? AND created_at > ?')
    .bind(k.address, now() - 86400).first<{ n: number }>();
  if ((cnt?.n ?? 0) >= cap) return bad(c, 429, 'daily upload limit reached');

  const buf = await file.arrayBuffer();
  const sha256 = await sha256Hex(buf);
  const dup = await c.env.DB.prepare('SELECT id, artist FROM submissions WHERE sha256 = ?').bind(sha256).first<{ id: string; artist: string }>();
  if (dup) return bad(c, 409, dup.artist === k.address ? 'you already uploaded this file' : 'this file has already been submitted by another artist');

  const id = crypto.randomUUID();
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const image_key = `works/${k.address}/${id}.${ext}`;
  await c.env.IMAGES.put(image_key, buf, { httpMetadata: { contentType: file.type }, customMetadata: { sha256, artist: k.address } });
  await c.env.DB.prepare(
    `INSERT INTO submissions (id, artist, collection_id, title, description, image_key, sha256, mime, bytes, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`)
    .bind(id, k.address, collection_id, title, description.slice(0, 2000) || null, image_key, sha256, file.type, file.size, now()).run();
  await audit(c.env, k.address, 'submission.create', id, { sha256, bytes: file.size });
  return c.json({ ok: true, id, sha256, status: 'pending' }, 201);
});

app.get('/api/submissions/mine', auth, async (c) => {
  const k = c.get('caller');
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, description, collection_id, image_key, sha256, status, review_note, reviewed_at, token_id, cid, created_at FROM submissions WHERE artist = ? ORDER BY created_at DESC')
    .bind(k.address).all();
  return c.json({ ok: true, submissions: results });
});

/** An artist may withdraw a submission that has not been reviewed yet. */
app.delete('/api/submissions/:id', auth, async (c) => {
  const k = c.get('caller');
  const sub = await c.env.DB.prepare('SELECT image_key, status FROM submissions WHERE id = ? AND artist = ?').bind(c.req.param('id'), k.address).first<{ image_key: string; status: string }>();
  if (!sub) return bad(c, 404, 'not found');
  if (sub.status !== 'pending') return bad(c, 409, `cannot withdraw a ${sub.status} submission`);
  await c.env.IMAGES.delete(sub.image_key);
  await c.env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(c.req.param('id')).run();
  await audit(c.env, k.address, 'submission.withdraw', c.req.param('id'));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ vetting queue (verifiers)

app.get('/api/verify/submissions', auth, requireVerifier, async (c) => {
  const status = c.req.query('status') || 'pending';
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.title, s.description, s.collection_id, s.image_key, s.sha256, s.mime, s.bytes, s.status, s.created_at,
            s.artist, p.display_name AS artist_name, s.reviewer, s.review_note
       FROM submissions s JOIN profiles p ON p.address = s.artist
      WHERE s.status = ? ORDER BY s.created_at ASC LIMIT 200`).bind(status).all();
  return c.json({ ok: true, submissions: results });
});

app.post('/api/verify/submissions/:id', auth, requireVerifier, async (c) => {
  const k = c.get('caller');
  const id = c.req.param('id');
  const b = await c.req.json<{ decision: 'approved' | 'rejected'; note?: string }>().catch(() => null);
  if (!b || !['approved', 'rejected'].includes(b.decision)) return bad(c, 400, 'decision must be approved|rejected');
  const sub = await c.env.DB.prepare('SELECT artist, status FROM submissions WHERE id = ?').bind(id).first<{ artist: string; status: string }>();
  if (!sub) return bad(c, 404, 'not found');
  if (sub.artist === k.address) return bad(c, 403, 'cannot review your own work');
  if (sub.status !== 'pending') return bad(c, 409, `already ${sub.status}`);
  await c.env.DB.prepare('UPDATE submissions SET status=?, reviewer=?, review_note=?, reviewed_at=? WHERE id=?')
    .bind(b.decision, k.address, b.note?.slice(0, 1000) ?? null, now(), id).run();
  await audit(c.env, k.address, `submission.${b.decision}`, id, { note: b.note });
  return c.json({ ok: true, status: b.decision });
});

// ------------------------------------------------------------------ admin

app.post('/api/admin/collections', auth, requireAdmin, async (c) => {
  const b = await c.req.json<{ id: number; slug: string; title: string; description?: string; status?: 'draft' | 'live' }>().catch(() => null);
  if (!b || !Number.isInteger(b.id) || b.id < 1 || !/^[a-z0-9-]{3,60}$/.test(b.slug || '') || !b.title) return bad(c, 400, 'id (u32), slug, title required');
  await c.env.DB.prepare('INSERT INTO collections (id, slug, title, description, status, created_at) VALUES (?,?,?,?,?,?)')
    .bind(b.id, b.slug, b.title.slice(0, 120), b.description?.slice(0, 2000) ?? null, b.status ?? 'draft', now()).run();
  await audit(c.env, c.get('caller').address, 'collection.create', String(b.id));
  return c.json({ ok: true }, 201);
});

/** Admin appoints a verifier (creates or converts their profile). Mirrors the on-chain rule:
 *  only the admin grants the "verifier" role. */
app.post('/api/admin/verifiers', auth, requireAdmin, async (c) => {
  const b = await c.req.json<{ address: string; display_name?: string }>().catch(() => null);
  if (!b || !STELLAR_ADDR.test(b.address || '')) return bad(c, 400, 'valid Stellar address required');
  const t = now();
  const existing = await c.env.DB.prepare('SELECT display_name FROM profiles WHERE address = ?').bind(b.address).first<{ display_name: string }>();
  if (existing) {
    await c.env.DB.prepare("UPDATE profiles SET persona='verifier', status='active', updated_at=? WHERE address=?").bind(t, b.address).run();
  } else {
    const name = (b.display_name || '').trim();
    if (name.length < 2) return bad(c, 400, 'display_name required for a new verifier');
    await c.env.DB.prepare("INSERT INTO profiles (address, persona, display_name, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind(b.address, 'verifier', name, 'active', t, t).run();
  }
  await audit(c.env, c.get('caller').address, 'verifier.appoint', b.address);
  return c.json({ ok: true, next: 'sign grant_role(address, "verifier") on chain' }, 201);
});

app.post('/api/admin/profiles/:address/status', auth, requireAdmin, async (c) => {
  const b = await c.req.json<{ status: 'active' | 'suspended' }>().catch(() => null);
  if (!b || !['active', 'suspended'].includes(b.status)) return bad(c, 400, 'status must be active|suspended');
  const r = await c.env.DB.prepare('UPDATE profiles SET status=?, updated_at=? WHERE address=?').bind(b.status, now(), c.req.param('address')).run();
  if (!r.meta.changes) return bad(c, 404, 'not found');
  await audit(c.env, c.get('caller').address, `profile.${b.status}`, c.req.param('address'));
  return c.json({ ok: true });
});

/** Admin: all collections (including drafts) and status/title edits. */
app.get('/api/admin/collections', auth, requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, slug, title, description, status, created_at FROM collections ORDER BY id').all();
  return c.json({ ok: true, collections: results });
});
app.patch('/api/admin/collections/:id', auth, requireAdmin, async (c) => {
  const b = await c.req.json<{ status?: 'draft' | 'live'; title?: string; description?: string }>().catch(() => null);
  if (!b) return bad(c, 400, 'json body required');
  const sets: string[] = []; const vals: unknown[] = [];
  if (b.status) { if (!['draft', 'live'].includes(b.status)) return bad(c, 400, 'status must be draft|live'); sets.push('status=?'); vals.push(b.status); }
  if (b.title) { sets.push('title=?'); vals.push(b.title.slice(0, 120)); }
  if (b.description !== undefined) { sets.push('description=?'); vals.push(b.description?.slice(0, 2000) ?? null); }
  if (!sets.length) return bad(c, 400, 'nothing to update');
  const r = await c.env.DB.prepare(`UPDATE collections SET ${sets.join(',')} WHERE id=?`).bind(...vals, c.req.param('id')).run();
  if (!r.meta.changes) return bad(c, 404, 'not found');
  await audit(c.env, c.get('caller').address, 'collection.update', c.req.param('id'), b);
  return c.json({ ok: true });
});

/** Admin: every profile, optionally filtered by persona or status. */
app.get('/api/admin/profiles', auth, requireAdmin, async (c) => {
  const persona = c.req.query('persona'); const status = c.req.query('status');
  const where: string[] = []; const vals: unknown[] = [];
  if (persona) { where.push('persona=?'); vals.push(persona); }
  if (status) { where.push('status=?'); vals.push(status); }
  const { results } = await c.env.DB.prepare(`SELECT address, persona, display_name, status, created_at FROM profiles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`).bind(...vals).all();
  return c.json({ ok: true, profiles: results });
});

/** Admin: what the contract itself says — who is admin, is minting paused, which accounts hold the verifier role. */
app.get('/api/admin/chain', auth, requireAdmin, async (c) => {
  const reader = chainReader(c.env as any);
  if (!reader) return bad(c, 503, 'chain not configured');
  const admin = await reader.read('get_admin', []).catch(() => null);
  const paused = await reader.read('paused', []).catch(() => null);
  const verifiers: Record<string, boolean> = {};
  for (const a of (c.req.query('verifiers') || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    verifiers[a] = await hasRole(reader, a, 'verifier').catch(() => false);
  }
  return c.json({ ok: true, contract_id: (c.env as MintEnv).CONTRACT_ID, admin: admin ? String(admin) : null, paused, verifiers });
});

app.get('/api/admin/audit', auth, requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
  return c.json({ ok: true, log: results });
});

app.use('/api/submissions/:id/prepare-mint', auth);
app.use('/api/submissions/:id/confirm-mint', auth);
app.use('/api/verify/artists/:address/sync', auth);
app.route('/', mintRoutes as any);
app.route('/', authRoutes as any);

app.notFound((c) => bad(c, 404, 'no such route'));
app.onError((err, c) => {
  console.error(err);
  return bad(c, 500, 'internal error');
});

export default {
  fetch: app.fetch,
  // Cron (wrangler.toml [triggers]): sweep expired sessions and challenges.
  async scheduled(_evt: ScheduledEvent, env: AuthEnv & MintEnv, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([sweepAuth(env), reconcileChain(env)]));
  },
};

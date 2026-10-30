/**
 * IPFS pinning for the canonical artwork + its metadata JSON.
 * Production: Pinata (free tier) via its REST API, authenticated with PINATA_JWT.
 * Dev (no PINATA_JWT): deterministic placeholder CIDs so the whole mint flow runs locally.
 *
 * The CID of the metadata JSON is what goes on chain; the metadata points at the image CID.
 */
export type IpfsEnv = { PINATA_JWT?: string; PINATA_GATEWAY?: string };

export interface Pinner {
  pinFile(bytes: ArrayBuffer, name: string, mime: string): Promise<string>;
  pinJson(obj: unknown, name: string): Promise<string>;
}

export class PinataPinner implements Pinner {
  constructor(private jwt: string) {}
  async pinFile(bytes: ArrayBuffer, name: string, mime: string): Promise<string> {
    const fd = new FormData();
    fd.set('file', new Blob([bytes], { type: mime }), name);
    fd.set('pinataMetadata', JSON.stringify({ name }));
    fd.set('pinataOptions', JSON.stringify({ cidVersion: 1 }));
    const r = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { Authorization: `Bearer ${this.jwt}` }, body: fd });
    if (!r.ok) throw new Error(`pinata file ${r.status}: ${await r.text()}`);
    return ((await r.json()) as { IpfsHash: string }).IpfsHash;
  }
  async pinJson(obj: unknown, name: string): Promise<string> {
    const r = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST', headers: { Authorization: `Bearer ${this.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinataContent: obj, pinataMetadata: { name }, pinataOptions: { cidVersion: 1 } }),
    });
    if (!r.ok) throw new Error(`pinata json ${r.status}: ${await r.text()}`);
    return ((await r.json()) as { IpfsHash: string }).IpfsHash;
  }
}

/** Dev stand-in: CIDs derived from content hashes. NOT real IPFS; clearly prefixed. */
export class DevPinner implements Pinner {
  private async h(data: ArrayBuffer | string) {
    const buf = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async pinFile(bytes: ArrayBuffer) { return 'bafydev-file-' + (await this.h(bytes)); }
  async pinJson(obj: unknown) { return 'bafydev-meta-' + (await this.h(JSON.stringify(obj))); }
}

export function pinnerFor(env: IpfsEnv): { pinner: Pinner; real: boolean } {
  return env.PINATA_JWT ? { pinner: new PinataPinner(env.PINATA_JWT), real: true } : { pinner: new DevPinner(), real: false };
}

/** The metadata document that the NFT's CID points to. Keep it stable: it is immutable once pinned. */
export function buildMetadata(p: {
  title: string; description: string | null; imageCid: string; mime: string; sha256: string;
  artist: string; artistName: string; collectionId: number | null; collectionTitle: string | null;
}) {
  return {
    name: p.title,
    description: p.description || '',
    image: `ipfs://${p.imageCid}`,
    image_mime: p.mime,
    sha256: p.sha256,
    artist: p.artist,
    artist_name: p.artistName,
    collection: p.collectionId,
    collection_title: p.collectionTitle,
    platform: 'Morianah Inc.',
    standard: 'morianah-work-v1',
  };
}

/**
 * Read-only access to the Morianah Works contract on Stellar (Soroban RPC).
 *
 * The API never signs anything: artists sign mints and verifiers sign role grants
 * in their own wallets. This module only *reads* the chain to confirm what happened.
 * All network calls go through `ChainReader` so tests can inject a fake.
 */
import { Address, Contract, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr, Account } from '@stellar/stellar-sdk';

export type ChainEnv = {
  CONTRACT_ID: string;        // C… address of morianah-works
  RPC_URL: string;            // e.g. https://soroban-testnet.stellar.org
  NETWORK_PASSPHRASE?: string;
};

export type TxStatus = { found: boolean; success: boolean; contractIds: string[] };

export interface ChainReader {
  /** Simulate a read-only contract call and return its decoded result. */
  read(fn: string, args: xdr.ScVal[]): Promise<unknown>;
  /** Look up a submitted transaction by hash. */
  tx(hash: string): Promise<TxStatus>;
}

// A throwaway source account for simulations: simulation never submits, so no funds/sequence needed.
const SIM_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

export class RpcChainReader implements ChainReader {
  private server: rpc.Server;
  private contract: Contract;
  private passphrase: string;
  constructor(private env: ChainEnv) {
    this.server = new rpc.Server(env.RPC_URL, { allowHttp: env.RPC_URL.startsWith('http://') });
    this.contract = new Contract(env.CONTRACT_ID);
    this.passphrase = env.NETWORK_PASSPHRASE || Networks.TESTNET;
  }
  async read(fn: string, args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(SIM_SOURCE, '0'), { fee: '100', networkPassphrase: this.passphrase })
      .addOperation(this.contract.call(fn, ...args)).setTimeout(30).build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error('simulation failed: ' + sim.error);
    const ret = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    return ret ? scValToNative(ret) : null;
  }
  async tx(hash: string): Promise<TxStatus> {
    const r = await this.server.getTransaction(hash);
    if (r.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { found: false, success: false, contractIds: [] };
    const success = r.status === rpc.Api.GetTransactionStatus.SUCCESS;
    // Which contracts did this transaction invoke? (parse the envelope with the SDK's own classes)
    const ids = new Set<string>();
    try {
      const envXdr = (r as any).envelopeXdr;
      const b64 = typeof envXdr === 'string' ? envXdr : envXdr.toXDR('base64');
      let parsed = TransactionBuilder.fromXDR(b64, this.passphrase);
      if ('innerTransaction' in parsed) parsed = (parsed as any).innerTransaction;
      for (const op of (parsed as any).operations as any[]) {
        if (op.type !== 'invokeHostFunction') continue;
        const hf = op.func as any; // SDK 17 wrapper: { type, invokeContract: { contractAddress, functionName, args } }
        if (hf.type !== 'hostFunctionTypeInvokeContract') continue;
        ids.add(Address.fromScAddress(hf.invokeContract.contractAddress).toString());
      }
    } catch { /* leave empty on unexpected shape */ }
    return { found: true, success, contractIds: [...ids] };
  }
}

// ---------------------------------------------------------------- typed helpers (pure: build args, decode results)

export function hexToBytes32(hex: string): xdr.ScVal {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('sha256 must be 64 hex chars');
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return xdr.ScVal.scvBytes(Buffer.from(b));
}

export const args = {
  tokenByHash: (sha256Hex: string) => [hexToBytes32(sha256Hex)],
  hasRole: (account: string, role: string) => [new Address(account).toScVal(), xdr.ScVal.scvSymbol(role)],
  work: (tokenId: number) => [nativeToScVal(tokenId, { type: 'u32' })],
};

/** token_by_hash → token id or null. */
export async function tokenByHash(reader: ChainReader, sha256Hex: string): Promise<number | null> {
  const v = await reader.read('token_by_hash', args.tokenByHash(sha256Hex));
  return v === null || v === undefined ? null : Number(v);
}

/** has_role → true if the account currently holds the role. */
export async function hasRole(reader: ChainReader, account: string, role: 'artist' | 'verifier'): Promise<boolean> {
  const v = await reader.read('has_role', args.hasRole(account, role));
  return v !== null && v !== undefined;
}

/** Build the unsigned mint_work invocation XDR for the artist's wallet to sign (browser does the simulate/prepare). */
export function mintArgs(artist: string, collection: number, cid: string, sha256Hex: string): xdr.ScVal[] {
  return [new Address(artist).toScVal(), nativeToScVal(collection, { type: 'u32' }), nativeToScVal(cid, { type: 'string' }), hexToBytes32(sha256Hex)];
}

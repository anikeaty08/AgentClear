import { MemData, type ShardedNodes } from '@0gfoundation/0g-storage-ts-sdk';
import { JsonRpcProvider } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  StorageIntegrityError,
  ZeroGStorageClient,
  type ZeroGStorageTransport,
} from '../src/index.js';

class MemoryTransport implements ZeroGStorageTransport {
  public constructor(
    private readonly stored: Uint8Array,
    private readonly alterDownload = false,
  ) {}

  public async upload(file: MemData) {
    const [tree, error] = await file.merkleTree();
    const rootHash = tree?.rootHash();
    if (error !== null || rootHash === null || rootHash === undefined) {
      throw new Error('Test file root was unavailable.');
    }
    return [
      {
        rootHash,
        txHash: `0x${'2'.repeat(64)}`,
        txSeq: 7,
      },
      null,
    ] satisfies Awaited<ReturnType<ZeroGStorageTransport['upload']>>;
  }

  public async downloadToBlob(): Promise<[Blob, Error | null]> {
    const data = this.alterDownload ? new TextEncoder().encode('altered') : this.stored;
    return [new Blob([data]), null];
  }

  public async getShardedNodes(): Promise<ShardedNodes> {
    return { trusted: [], discovered: [] };
  }
}

const privateKey = `0x${'1'.repeat(64)}` as const;

function createClient(data: Uint8Array, alterDownload = false) {
  const provider = new JsonRpcProvider('http://127.0.0.1:8545');
  return new ZeroGStorageClient(
    {
      rpcUrl: 'http://127.0.0.1:8545',
      indexerUrl: 'http://127.0.0.1:5678',
      signerPrivateKey: privateKey,
      maxPayloadBytes: 1_024,
    },
    {
      transport: new MemoryTransport(data, alterDownload),
      provider,
    },
  );
}

describe('ZeroGStorageClient', () => {
  it('computes a Merkle root, uploads, proof-downloads, and compares the bytes', async () => {
    const data = new TextEncoder().encode('{"result":"verified"}');
    const result = await createClient(data).uploadVerified(data);

    expect(result).toEqual({
      rootHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      transactionHash: `0x${'2'.repeat(64)}`,
      transactionSequence: 7,
      sizeBytes: data.byteLength,
      verified: true,
    });
  });

  it('rejects retrieved evidence whose bytes differ despite a successful SDK response', async () => {
    const data = new TextEncoder().encode('{"result":"verified"}');

    await expect(createClient(data, true).uploadVerified(data)).rejects.toBeInstanceOf(
      StorageIntegrityError,
    );
  });

  it('uses the current SDK MemData implementation without temporary files', async () => {
    const data = new TextEncoder().encode('same content');
    const [firstTree] = await new MemData(data).merkleTree();
    const [secondTree] = await new MemData(data).merkleTree();

    expect(firstTree?.rootHash()).toBe(secondTree?.rootHash());
  });
});

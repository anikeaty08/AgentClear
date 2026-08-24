import {
  Indexer,
  MemData,
  type DownloadOption,
  type ShardedNodes,
  type UploadOption,
} from '@0gfoundation/0g-storage-ts-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

type SingleUploadResult = {
  txHash: string;
  rootHash: string;
  txSeq: number;
};

type FragmentedUploadResult = {
  txHashes: string[];
  rootHashes: string[];
  txSeqs: number[];
};

export interface ZeroGStorageTransport {
  upload(
    file: MemData,
    uploadOptions?: UploadOption,
  ): Promise<[SingleUploadResult | FragmentedUploadResult, Error | null]>;
  downloadToBlob(
    rootHash: string,
    options?: DownloadOption,
  ): Promise<[Blob, Error | null]>;
  getShardedNodes(): Promise<ShardedNodes>;
}

export type ZeroGStorageClientOptions = {
  rpcUrl: string;
  indexerUrl: string;
  signerPrivateKey: `0x${string}`;
  maxPayloadBytes: number;
};

export type ZeroGStorageClientDependencies = {
  transport?: ZeroGStorageTransport;
  provider?: JsonRpcProvider;
};

export type StoredEvidence = {
  rootHash: `0x${string}`;
  transactionHash: `0x${string}` | null;
  transactionSequence: number;
  sizeBytes: number;
  verified: true;
};

export type StorageHealth = {
  chainId: number;
  storageNodes: number;
};

export class StorageConfigurationError extends Error {}
export class StorageOperationError extends Error {}
export class StorageIntegrityError extends Error {}

const rootHashPattern = /^0x[0-9a-fA-F]{64}$/;
const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/;

class SdkZeroGStorageTransport implements ZeroGStorageTransport {
  readonly #indexer: Indexer;
  readonly #rpcUrl: string;
  readonly #signer: Parameters<Indexer['upload']>[2];

  public constructor(indexerUrl: string, rpcUrl: string, privateKey: `0x${string}`) {
    this.#indexer = new Indexer(indexerUrl);
    this.#rpcUrl = rpcUrl;
    const provider = new JsonRpcProvider(rpcUrl);
    // The SDK 1.2.11 declaration resolves ethers through its CJS path under NodeNext,
    // while its ESM runtime accepts the same ethers v6 Wallet instance.
    this.#signer = new Wallet(privateKey, provider) as unknown as Parameters<
      Indexer['upload']
    >[2];
  }

  public async upload(file: MemData, uploadOptions?: UploadOption) {
    return this.#indexer.upload(file, this.#rpcUrl, this.#signer, uploadOptions);
  }

  public async downloadToBlob(rootHash: string, options?: DownloadOption) {
    return this.#indexer.downloadToBlob(rootHash, options);
  }

  public async getShardedNodes(): Promise<ShardedNodes> {
    return this.#indexer.getShardedNodes();
  }
}

export class ZeroGStorageClient {
  readonly #options: ZeroGStorageClientOptions;
  readonly #transport: ZeroGStorageTransport;
  readonly #provider: JsonRpcProvider;

  public constructor(
    options: ZeroGStorageClientOptions,
    dependencies: ZeroGStorageClientDependencies = {},
  ) {
    if (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes <= 0) {
      throw new StorageConfigurationError('Storage payload limit must be a positive integer.');
    }
    this.#options = options;
    this.#provider = dependencies.provider ?? new JsonRpcProvider(options.rpcUrl);
    this.#transport = dependencies.transport ?? new SdkZeroGStorageTransport(
      options.indexerUrl,
      options.rpcUrl,
      options.signerPrivateKey,
    );
  }

  public async uploadVerified(data: Uint8Array): Promise<StoredEvidence> {
    this.#validatePayload(data);
    const file = new MemData(data);
    const rootHash = await this.#merkleRoot(file);
    const [result, uploadError] = await this.#transport.upload(
      file,
      {
        expectedReplica: 1,
        finalityRequired: true,
        skipIfFinalized: true,
        skipTx: true,
      },
    );
    if (uploadError !== null) {
      throw new StorageOperationError('0G Storage rejected the evidence upload.');
    }
    if (!('rootHash' in result)) {
      throw new StorageIntegrityError('Unexpected fragmented response for a bounded payload.');
    }
    if (result.rootHash.toLowerCase() !== rootHash.toLowerCase()) {
      throw new StorageIntegrityError('0G Storage returned a different evidence root.');
    }
    if (!Number.isSafeInteger(result.txSeq) || result.txSeq < 0) {
      throw new StorageIntegrityError('0G Storage returned an invalid transaction sequence.');
    }

    const downloaded = await this.downloadVerified(rootHash);
    if (!Buffer.from(downloaded).equals(Buffer.from(data))) {
      throw new StorageIntegrityError('Verified retrieval did not match the submitted evidence.');
    }

    const transactionHash = result.txHash === '' ? null : this.#transactionHash(result.txHash);
    return {
      rootHash,
      transactionHash,
      transactionSequence: result.txSeq,
      sizeBytes: data.byteLength,
      verified: true,
    };
  }

  public async downloadVerified(rootHash: string): Promise<Uint8Array> {
    if (!rootHashPattern.test(rootHash)) {
      throw new StorageIntegrityError('The 0G Storage root hash is invalid.');
    }
    const [blob, downloadError] = await this.#transport.downloadToBlob(rootHash, { proof: true });
    if (downloadError !== null) {
      throw new StorageOperationError('0G Storage evidence retrieval failed.');
    }
    if (blob.size > this.#options.maxPayloadBytes) {
      throw new StorageIntegrityError('Retrieved evidence exceeds the configured payload limit.');
    }
    return new Uint8Array(await blob.arrayBuffer());
  }

  public async health(): Promise<StorageHealth> {
    const [network, nodes] = await Promise.all([
      this.#provider.getNetwork(),
      this.#transport.getShardedNodes(),
    ]);
    const storageNodes = nodes.trusted.length + nodes.discovered.length;
    if (storageNodes === 0) {
      throw new StorageOperationError('The 0G Storage indexer returned no storage nodes.');
    }
    const chainId = Number(network.chainId);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new StorageIntegrityError('The storage RPC returned an invalid chain ID.');
    }
    return { chainId, storageNodes };
  }

  async #merkleRoot(file: MemData): Promise<`0x${string}`> {
    const [tree, treeError] = await file.merkleTree();
    const rootHash = tree?.rootHash();
    if (treeError !== null || rootHash === null || rootHash === undefined) {
      throw new StorageOperationError('Could not compute the 0G Storage evidence root.');
    }
    if (!rootHashPattern.test(rootHash)) {
      throw new StorageIntegrityError('The computed 0G Storage root is invalid.');
    }
    return rootHash as `0x${string}`;
  }

  #transactionHash(value: string): `0x${string}` {
    if (!transactionHashPattern.test(value)) {
      throw new StorageIntegrityError('0G Storage returned an invalid transaction hash.');
    }
    return value as `0x${string}`;
  }

  #validatePayload(data: Uint8Array): void {
    if (data.byteLength === 0) {
      throw new StorageIntegrityError('Evidence cannot be empty.');
    }
    if (data.byteLength > this.#options.maxPayloadBytes) {
      throw new StorageIntegrityError('Evidence exceeds the configured payload limit.');
    }
  }
}

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToBytes,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { jobEscrowAbi } from './job-escrow-abi.js';

export const ESCROW_STATE = {
  NONE: 0,
  FUNDED: 1,
  DISPUTED: 2,
  RELEASED: 3,
  REFUNDED: 4,
} as const;

export type EscrowState = (typeof ESCROW_STATE)[keyof typeof ESCROW_STATE];

export type EscrowGatewayOptions = {
  rpcUrl: string;
  chain: Chain;
  contractAddress: Address;
  account: Account | Address;
  confirmations?: number;
};

export type PrivateKeyEscrowGatewayOptions = Omit<EscrowGatewayOptions, 'account'> & {
  privateKey: Hex;
};

export type FundEscrowCommand = {
  jobId: string;
  agreementHash: Hex;
  providerAddress?: Address;
  amountBaseUnits: string;
  deadline: string;
};

export type EscrowRecord = {
  jobKey: Hex;
  buyer: Address;
  provider: Address | null;
  amountBaseUnits: string;
  deadline: string;
  state: EscrowState;
  agreementHash: Hex;
};

export type ConfirmedChainWrite = {
  transactionHash: Hex;
  blockNumber: string;
  contractAddress: Address;
};

export type FundEscrowResult = ConfirmedChainWrite & {
  escrow: EscrowRecord;
};

export type PreparedFundingTransaction = {
  jobKey: Hex;
  transactionHash: Hex;
  serializedTransaction: Hex;
  contractAddress: Address;
  signerAddress: Address;
};

export type ChainHealth = {
  chainId: number;
  contractDeployed: true;
};

export class ChainConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ChainConfigurationError';
  }
}

export class ChainTransactionRevertedError extends Error {
  public constructor(public readonly transactionHash: Hex) {
    super(`Chain transaction ${transactionHash} reverted.`);
    this.name = 'ChainTransactionRevertedError';
  }
}

export class EscrowAttestationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EscrowAttestationError';
  }
}

function accountAddress(account: Account | Address): Address {
  return typeof account === 'string' ? getAddress(account) : getAddress(account.address);
}

function validateOptions(options: EscrowGatewayOptions): void {
  if (!URL.canParse(options.rpcUrl)) {
    throw new ChainConfigurationError('The chain RPC URL is invalid.');
  }
  if (options.chain.id <= 0 || !Number.isSafeInteger(options.chain.id)) {
    throw new ChainConfigurationError('The chain ID must be a positive safe integer.');
  }
  if (!isAddress(options.contractAddress) || options.contractAddress === zeroAddress) {
    throw new ChainConfigurationError('The escrow contract address is invalid.');
  }
  if (options.confirmations !== undefined && options.confirmations < 1) {
    throw new ChainConfigurationError('Transaction confirmations must be at least one.');
  }
}

function requireBytes32(value: Hex, field: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ChainConfigurationError(`${field} must be a 32-byte hex value.`);
  }
}

function parseAmount(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ChainConfigurationError('Escrow amount must be a positive base-unit integer string.');
  }
  return BigInt(value);
}

export function jobIdToEscrowKey(jobId: string): Hex {
  if (jobId.trim().length === 0) {
    throw new ChainConfigurationError('The job ID cannot be empty.');
  }
  return keccak256(stringToBytes(jobId));
}

export function deadlineToUnixSeconds(deadline: string): bigint {
  const milliseconds = Date.parse(deadline);
  if (!Number.isFinite(milliseconds)) {
    throw new ChainConfigurationError('The job deadline is invalid.');
  }
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds <= 0 || seconds > 2 ** 53 - 1) {
    throw new ChainConfigurationError('The job deadline is outside the supported range.');
  }
  return BigInt(seconds);
}

export function createPrivateKeyEscrowGateway(
  options: PrivateKeyEscrowGatewayOptions,
): ViemJobEscrowGateway {
  let account: Account;
  try {
    account = privateKeyToAccount(options.privateKey);
  } catch {
    throw new ChainConfigurationError('The chain signer private key is invalid.');
  }

  return new ViemJobEscrowGateway({
    rpcUrl: options.rpcUrl,
    chain: options.chain,
    contractAddress: options.contractAddress,
    account,
    ...(options.confirmations === undefined ? {} : { confirmations: options.confirmations }),
  });
}

export class ViemJobEscrowGateway {
  readonly #options: EscrowGatewayOptions;

  public constructor(options: EscrowGatewayOptions) {
    validateOptions(options);
    this.#options = {
      ...options,
      contractAddress: getAddress(options.contractAddress),
      account: typeof options.account === 'string' ? getAddress(options.account) : options.account,
    };
  }

  public get signerAddress(): Address {
    return accountAddress(this.#options.account);
  }

  public async health(): Promise<ChainHealth> {
    const { publicClient } = this.#clients();
    const [chainId, bytecode] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getCode({ address: this.#options.contractAddress }),
    ]);
    if (chainId !== this.#options.chain.id) {
      throw new ChainConfigurationError(
        `RPC chain ID ${chainId} does not match configured chain ID ${this.#options.chain.id}.`,
      );
    }
    if (bytecode === undefined || bytecode === '0x') {
      throw new ChainConfigurationError('No escrow contract bytecode exists at the configured address.');
    }
    return { chainId, contractDeployed: true };
  }

  public async fundJob(command: FundEscrowCommand): Promise<FundEscrowResult> {
    const prepared = await this.prepareFundJob(command);
    await this.broadcastPreparedFunding(prepared);
    return this.confirmFundJob(command, prepared);
  }

  /// Prepares and signs without broadcasting so the caller can persist the exact transaction first.
  public async prepareFundJob(command: FundEscrowCommand): Promise<PreparedFundingTransaction> {
    requireBytes32(command.agreementHash, 'agreementHash');
    const jobKey = jobIdToEscrowKey(command.jobId);
    const amount = parseAmount(command.amountBaseUnits);
    const deadline = deadlineToUnixSeconds(command.deadline);
    const provider = command.providerAddress ?? zeroAddress;
    if (!isAddress(provider)) {
      throw new ChainConfigurationError('The provider address is invalid.');
    }

    if (typeof this.#options.account === 'string') {
      throw new ChainConfigurationError(
        'Durable funding requires a local signer account, not an unlocked RPC address.',
      );
    }

    const { publicClient, walletClient } = this.#clients();
    await publicClient.simulateContract({
      account: this.#options.account,
      address: this.#options.contractAddress,
      abi: jobEscrowAbi,
      functionName: 'fundJob',
      args: [jobKey, getAddress(provider), deadline, command.agreementHash],
      value: amount,
    });

    const data = encodeFunctionData({
      abi: jobEscrowAbi,
      functionName: 'fundJob',
      args: [jobKey, getAddress(provider), deadline, command.agreementHash],
    });
    const request = await walletClient.prepareTransactionRequest({
      account: this.#options.account,
      to: this.#options.contractAddress,
      data,
      value: amount,
    });
    const serializedTransaction = await walletClient.signTransaction(request);
    return {
      jobKey,
      transactionHash: keccak256(serializedTransaction),
      serializedTransaction,
      contractAddress: this.#options.contractAddress,
      signerAddress: this.signerAddress,
    };
  }

  /// Broadcasts a persisted signed transaction. Replays return the same hash when already known.
  public async broadcastPreparedFunding(prepared: PreparedFundingTransaction): Promise<Hex> {
    if (prepared.contractAddress !== this.#options.contractAddress) {
      throw new ChainConfigurationError('The prepared transaction targets a different escrow contract.');
    }
    if (keccak256(prepared.serializedTransaction) !== prepared.transactionHash) {
      throw new ChainConfigurationError('The prepared transaction hash does not match its payload.');
    }
    const { publicClient } = this.#clients();
    try {
      const submittedHash = await publicClient.sendRawTransaction({
        serializedTransaction: prepared.serializedTransaction,
      });
      if (submittedHash !== prepared.transactionHash) {
        throw new EscrowAttestationError('The RPC returned an unexpected transaction hash.');
      }
      return submittedHash;
    } catch (submissionError) {
      try {
        await publicClient.getTransaction({ hash: prepared.transactionHash });
        return prepared.transactionHash;
      } catch {
        throw submissionError;
      }
    }
  }

  public async confirmFundJob(
    command: FundEscrowCommand,
    prepared: PreparedFundingTransaction,
  ): Promise<FundEscrowResult> {
    requireBytes32(command.agreementHash, 'agreementHash');
    const expectedJobKey = jobIdToEscrowKey(command.jobId);
    const amount = parseAmount(command.amountBaseUnits);
    if (prepared.jobKey !== expectedJobKey || prepared.signerAddress !== this.signerAddress) {
      throw new ChainConfigurationError('The prepared transaction does not match this funding request.');
    }

    const { publicClient } = this.#clients();
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: prepared.transactionHash,
      confirmations: this.#options.confirmations ?? 1,
    });
    if (receipt.status !== 'success') {
      throw new ChainTransactionRevertedError(prepared.transactionHash);
    }

    const escrow = await this.getEscrowByKey(expectedJobKey);
    const expectedBuyer = this.signerAddress;
    if (
      escrow.buyer !== expectedBuyer
      || escrow.amountBaseUnits !== amount.toString()
      || escrow.agreementHash.toLowerCase() !== command.agreementHash.toLowerCase()
      || escrow.state !== ESCROW_STATE.FUNDED
    ) {
      throw new EscrowAttestationError('Confirmed funding does not match the expected escrow state.');
    }

    return {
      transactionHash: prepared.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      contractAddress: this.#options.contractAddress,
      escrow,
    };
  }

  public async assignProvider(jobId: string, providerAddress: Address): Promise<ConfirmedChainWrite> {
    if (!isAddress(providerAddress) || providerAddress === zeroAddress) {
      throw new ChainConfigurationError('The provider address is invalid.');
    }
    const jobKey = jobIdToEscrowKey(jobId);
    const provider = getAddress(providerAddress);
    const { publicClient, walletClient } = this.#clients();
    const { request } = await publicClient.simulateContract({
      account: this.#options.account,
      address: this.#options.contractAddress,
      abi: jobEscrowAbi,
      functionName: 'assignProvider',
      args: [jobKey, provider],
    });
    const transactionHash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations: this.#options.confirmations ?? 1,
    });
    if (receipt.status !== 'success') {
      throw new ChainTransactionRevertedError(transactionHash);
    }

    const escrow = await this.getEscrowByKey(jobKey);
    if (escrow.provider !== provider) {
      throw new EscrowAttestationError('Confirmed assignment does not match the requested provider.');
    }

    return {
      transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      contractAddress: this.#options.contractAddress,
    };
  }

  public async getEscrow(jobId: string): Promise<EscrowRecord> {
    return this.getEscrowByKey(jobIdToEscrowKey(jobId));
  }

  private async getEscrowByKey(jobKey: Hex): Promise<EscrowRecord> {
    const { publicClient } = this.#clients();
    const [buyer, provider, amount, deadline, state, agreementHash] =
      await publicClient.readContract({
        address: this.#options.contractAddress,
        abi: jobEscrowAbi,
        functionName: 'escrows',
        args: [jobKey],
      });

    return {
      jobKey,
      buyer: getAddress(buyer),
      provider: provider === zeroAddress ? null : getAddress(provider),
      amountBaseUnits: amount.toString(),
      deadline: new Date(Number(deadline) * 1_000).toISOString(),
      state: state as EscrowState,
      agreementHash,
    };
  }

  #clients() {
    const transport = http(this.#options.rpcUrl);
    return {
      publicClient: createPublicClient({ chain: this.#options.chain, transport }),
      walletClient: createWalletClient({
        account: this.#options.account,
        chain: this.#options.chain,
        transport,
      }),
    };
  }
}

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

import {
  ChainConfigurationError,
  ChainTransactionRevertedError,
  EscrowAttestationError,
  jobIdToEscrowKey,
} from './job-escrow-gateway.js';
import { outcomeRegistryAbi } from './outcome-registry-abi.js';

export const CHAIN_OUTCOME = { PASS: 1, FAIL: 2 } as const;
export type ChainOutcome = keyof typeof CHAIN_OUTCOME;

export type RecordOutcomeCommand = {
  jobId: string;
  agreementHash: Hex;
  submissionHash: Hex;
  verificationReportHash: Hex;
  buyerAgentId: string;
  providerAgentId: string;
  outcome: ChainOutcome;
};

export type OutcomeRegistryOptions = {
  rpcUrl: string;
  chain: Chain;
  contractAddress: Address;
  account: Account | Address;
  confirmations?: number;
};

export type PrivateKeyOutcomeRegistryOptions = Omit<OutcomeRegistryOptions, 'account'> & {
  privateKey: Hex;
};

export type PreparedOutcomeTransaction = {
  jobKey: Hex;
  transactionHash: Hex;
  serializedTransaction: Hex;
  contractAddress: Address;
  signerAddress: Address;
};

export type OutcomeRecord = {
  jobKey: Hex;
  agreementHash: Hex;
  submissionHash: Hex;
  verificationReportHash: Hex;
  buyerIdentityHash: Hex;
  providerIdentityHash: Hex;
  outcome: ChainOutcome;
  finalizedAt: string;
};

export type ConfirmedOutcomeWrite = {
  transactionHash: Hex;
  blockNumber: string;
  contractAddress: Address;
  record: OutcomeRecord;
};

function requireBytes32(value: Hex, name: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ChainConfigurationError(`${name} must be a 32-byte hex value.`);
  }
}

function accountAddress(account: Account | Address): Address {
  return typeof account === 'string' ? getAddress(account) : getAddress(account.address);
}

export function agentIdentityToHash(agentId: string): Hex {
  if (!/^erc8004:\d+:\d+$/.test(agentId)) {
    throw new ChainConfigurationError('Agent identity must use erc8004:<chainId>:<tokenId>.');
  }
  return keccak256(stringToBytes(agentId));
}

export function createPrivateKeyOutcomeRegistryGateway(
  options: PrivateKeyOutcomeRegistryOptions,
): ViemOutcomeRegistryGateway {
  let account: Account;
  try {
    account = privateKeyToAccount(options.privateKey);
  } catch {
    throw new ChainConfigurationError('The chain signer private key is invalid.');
  }
  return new ViemOutcomeRegistryGateway({
    rpcUrl: options.rpcUrl,
    chain: options.chain,
    contractAddress: options.contractAddress,
    account,
    ...(options.confirmations === undefined ? {} : { confirmations: options.confirmations }),
  });
}

export class ViemOutcomeRegistryGateway {
  readonly #options: OutcomeRegistryOptions;

  public constructor(options: OutcomeRegistryOptions) {
    if (!URL.canParse(options.rpcUrl)) throw new ChainConfigurationError('The chain RPC URL is invalid.');
    if (!isAddress(options.contractAddress) || options.contractAddress === zeroAddress) {
      throw new ChainConfigurationError('The outcome registry address is invalid.');
    }
    if (options.confirmations !== undefined && options.confirmations < 1) {
      throw new ChainConfigurationError('Transaction confirmations must be at least one.');
    }
    this.#options = {
      ...options,
      contractAddress: getAddress(options.contractAddress),
      account: typeof options.account === 'string' ? getAddress(options.account) : options.account,
    };
  }

  public get signerAddress(): Address {
    return accountAddress(this.#options.account);
  }

  public get contractAddress(): Address {
    return this.#options.contractAddress;
  }

  public async health(): Promise<{ chainId: number; contractDeployed: true }> {
    const client = this.#publicClient();
    const [chainId, bytecode] = await Promise.all([
      client.getChainId(),
      client.getCode({ address: this.#options.contractAddress }),
    ]);
    if (chainId !== this.#options.chain.id) {
      throw new ChainConfigurationError('Outcome registry RPC chain ID does not match configuration.');
    }
    if (bytecode === undefined || bytecode === '0x') {
      throw new ChainConfigurationError('No outcome registry bytecode exists at the configured address.');
    }
    return { chainId, contractDeployed: true };
  }

  public async prepareRecordOutcome(
    command: RecordOutcomeCommand,
  ): Promise<PreparedOutcomeTransaction> {
    for (const [name, value] of [
      ['agreementHash', command.agreementHash],
      ['submissionHash', command.submissionHash],
      ['verificationReportHash', command.verificationReportHash],
    ] as const) {
      requireBytes32(value, name);
    }
    if (typeof this.#options.account === 'string') {
      throw new ChainConfigurationError('Durable outcome writes require a local signer account.');
    }
    const jobKey = jobIdToEscrowKey(command.jobId);
    const args = [
      jobKey,
      command.agreementHash,
      command.submissionHash,
      command.verificationReportHash,
      agentIdentityToHash(command.buyerAgentId),
      agentIdentityToHash(command.providerAgentId),
      CHAIN_OUTCOME[command.outcome],
    ] as const;
    const publicClient = this.#publicClient();
    const walletClient = this.#walletClient();
    await publicClient.simulateContract({
      account: this.#options.account,
      address: this.#options.contractAddress,
      abi: outcomeRegistryAbi,
      functionName: 'recordOutcome',
      args,
    });
    const data = encodeFunctionData({
      abi: outcomeRegistryAbi,
      functionName: 'recordOutcome',
      args,
    });
    const request = await walletClient.prepareTransactionRequest({
      account: this.#options.account,
      to: this.#options.contractAddress,
      data,
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

  public async broadcastPreparedOutcome(prepared: PreparedOutcomeTransaction): Promise<Hex> {
    if (prepared.contractAddress !== this.#options.contractAddress) {
      throw new ChainConfigurationError('Prepared outcome targets another contract.');
    }
    if (keccak256(prepared.serializedTransaction) !== prepared.transactionHash) {
      throw new ChainConfigurationError('Prepared outcome hash does not match its payload.');
    }
    const client = this.#publicClient();
    try {
      const hash = await client.sendRawTransaction({ serializedTransaction: prepared.serializedTransaction });
      if (hash !== prepared.transactionHash) {
        throw new EscrowAttestationError('RPC returned an unexpected outcome transaction hash.');
      }
      return hash;
    } catch (submissionError) {
      try {
        await client.getTransaction({ hash: prepared.transactionHash });
        return prepared.transactionHash;
      } catch {
        throw submissionError;
      }
    }
  }

  public async confirmRecordOutcome(
    command: RecordOutcomeCommand,
    prepared: PreparedOutcomeTransaction,
  ): Promise<ConfirmedOutcomeWrite> {
    const jobKey = jobIdToEscrowKey(command.jobId);
    if (prepared.jobKey !== jobKey || prepared.signerAddress !== this.signerAddress) {
      throw new ChainConfigurationError('Prepared transaction does not match this outcome.');
    }
    const client = this.#publicClient();
    const receipt = await client.waitForTransactionReceipt({
      hash: prepared.transactionHash,
      confirmations: this.#options.confirmations ?? 1,
    });
    if (receipt.status !== 'success') throw new ChainTransactionRevertedError(prepared.transactionHash);
    const record = await this.getOutcome(command.jobId);
    if (
      record.agreementHash.toLowerCase() !== command.agreementHash.toLowerCase()
      || record.submissionHash.toLowerCase() !== command.submissionHash.toLowerCase()
      || record.verificationReportHash.toLowerCase() !== command.verificationReportHash.toLowerCase()
      || record.buyerIdentityHash !== agentIdentityToHash(command.buyerAgentId)
      || record.providerIdentityHash !== agentIdentityToHash(command.providerAgentId)
      || record.outcome !== command.outcome
    ) {
      throw new EscrowAttestationError('Confirmed outcome does not match the expected commitments.');
    }
    return {
      transactionHash: prepared.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      contractAddress: this.#options.contractAddress,
      record,
    };
  }

  public async getOutcome(jobId: string): Promise<OutcomeRecord> {
    const jobKey = jobIdToEscrowKey(jobId);
    const [agreementHash, submissionHash, verificationReportHash, buyerIdentityHash, providerIdentityHash, rawOutcome, finalizedAt] =
      await this.#publicClient().readContract({
        address: this.#options.contractAddress,
        abi: outcomeRegistryAbi,
        functionName: 'outcomes',
        args: [jobKey],
      });
    const outcome = rawOutcome === CHAIN_OUTCOME.PASS
      ? 'PASS'
      : rawOutcome === CHAIN_OUTCOME.FAIL
        ? 'FAIL'
        : undefined;
    if (outcome === undefined) throw new EscrowAttestationError('No finalized outcome exists for this job.');
    return {
      jobKey,
      agreementHash,
      submissionHash,
      verificationReportHash,
      buyerIdentityHash,
      providerIdentityHash,
      outcome,
      finalizedAt: new Date(Number(finalizedAt) * 1_000).toISOString(),
    };
  }

  #publicClient() {
    return createPublicClient({ chain: this.#options.chain, transport: http(this.#options.rpcUrl) });
  }

  #walletClient() {
    return createWalletClient({
      account: this.#options.account,
      chain: this.#options.chain,
      transport: http(this.#options.rpcUrl),
    });
  }
}

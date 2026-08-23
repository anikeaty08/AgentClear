import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEventLogs,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { erc8004IdentityRegistryAbi, erc8004ReputationRegistryAbi } from './erc8004-abi.js';
import {
  ChainConfigurationError,
  ChainTransactionRevertedError,
  EscrowAttestationError,
} from './job-escrow-gateway.js';

const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;

export type Erc8004FeedbackCommand = {
  providerAgentId: string;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
  feedbackHash: Hex;
};

export type PreparedErc8004Feedback = {
  agentTokenId: string;
  transactionHash: Hex;
  serializedTransaction: Hex;
  contractAddress: Address;
  identityRegistryAddress: Address;
  signerAddress: Address;
};

export type ConfirmedErc8004Feedback = {
  transactionHash: Hex;
  blockNumber: string;
  feedbackIndex: string;
  clientAddress: Address;
};

export type Erc8004ReputationGatewayOptions = {
  rpcUrl: string;
  chain: Chain;
  identityRegistryAddress: Address;
  reputationRegistryAddress: Address;
  account: Account | Address;
  confirmations?: number;
};

export type PrivateKeyErc8004ReputationGatewayOptions = Omit<
  Erc8004ReputationGatewayOptions,
  'account'
> & { privateKey: Hex };

export function parseAgentIdentity(identity: string): { chainId: number; tokenId: bigint } {
  const match = /^erc8004:(\d+):(\d+)$/.exec(identity);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new ChainConfigurationError('Agent identity must use erc8004:<chainId>:<tokenId>.');
  }
  const chainId = Number(match[1]);
  const tokenId = BigInt(match[2]);
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new ChainConfigurationError('Agent identity chain ID is invalid.');
  }
  return { chainId, tokenId };
}

export function createPrivateKeyErc8004ReputationGateway(
  options: PrivateKeyErc8004ReputationGatewayOptions,
): ViemErc8004ReputationGateway {
  let account: Account;
  try {
    account = privateKeyToAccount(options.privateKey);
  } catch {
    throw new ChainConfigurationError('The chain signer private key is invalid.');
  }
  return new ViemErc8004ReputationGateway({
    ...options,
    account,
  });
}

export class ViemErc8004ReputationGateway {
  readonly #options: Erc8004ReputationGatewayOptions;

  public constructor(options: Erc8004ReputationGatewayOptions) {
    if (!URL.canParse(options.rpcUrl)) throw new ChainConfigurationError('The chain RPC URL is invalid.');
    if (!isAddress(options.identityRegistryAddress) || options.identityRegistryAddress === zeroAddress) {
      throw new ChainConfigurationError('The ERC-8004 identity registry address is invalid.');
    }
    if (!isAddress(options.reputationRegistryAddress) || options.reputationRegistryAddress === zeroAddress) {
      throw new ChainConfigurationError('The ERC-8004 reputation registry address is invalid.');
    }
    if (options.confirmations !== undefined && options.confirmations < 1) {
      throw new ChainConfigurationError('Transaction confirmations must be at least one.');
    }
    this.#options = {
      ...options,
      identityRegistryAddress: getAddress(options.identityRegistryAddress),
      reputationRegistryAddress: getAddress(options.reputationRegistryAddress),
      account: typeof options.account === 'string' ? getAddress(options.account) : options.account,
    };
  }

  public get signerAddress(): Address {
    return typeof this.#options.account === 'string'
      ? getAddress(this.#options.account)
      : getAddress(this.#options.account.address);
  }

  public get contractAddress(): Address {
    return this.#options.reputationRegistryAddress;
  }

  public get identityRegistryAddress(): Address {
    return this.#options.identityRegistryAddress;
  }

  public async health(): Promise<{
    chainId: number;
    identityRegistryLinked: true;
    contractsDeployed: true;
  }> {
    const client = this.#publicClient();
    const [chainId, identityCode, reputationCode, linkedIdentity] = await Promise.all([
      client.getChainId(),
      client.getCode({ address: this.#options.identityRegistryAddress }),
      client.getCode({ address: this.#options.reputationRegistryAddress }),
      client.readContract({
        address: this.#options.reputationRegistryAddress,
        abi: erc8004ReputationRegistryAbi,
        functionName: 'getIdentityRegistry',
      }),
    ]);
    if (chainId !== this.#options.chain.id) {
      throw new ChainConfigurationError('ERC-8004 RPC chain ID does not match configuration.');
    }
    if (identityCode === undefined || identityCode === '0x' || reputationCode === undefined || reputationCode === '0x') {
      throw new ChainConfigurationError('ERC-8004 registry bytecode is missing.');
    }
    if (getAddress(linkedIdentity) !== this.#options.identityRegistryAddress) {
      throw new ChainConfigurationError('ReputationRegistry links to an unexpected IdentityRegistry.');
    }
    return { chainId, identityRegistryLinked: true, contractsDeployed: true };
  }

  public async prepareFeedback(command: Erc8004FeedbackCommand): Promise<PreparedErc8004Feedback> {
    const { chainId, tokenId } = this.#validateCommand(command);
    if (chainId !== this.#options.chain.id) {
      throw new ChainConfigurationError('Provider identity is registered on another chain.');
    }
    if (typeof this.#options.account === 'string') {
      throw new ChainConfigurationError('Durable reputation writes require a local signer account.');
    }
    const publicClient = this.#publicClient();
    const owner = await publicClient.readContract({
      address: this.#options.identityRegistryAddress,
      abi: erc8004IdentityRegistryAbi,
      functionName: 'ownerOf',
      args: [tokenId],
    });
    if (getAddress(owner) === this.signerAddress) {
      throw new ChainConfigurationError('The feedback signer cannot own the provider identity.');
    }
    const args = this.#feedbackArgs(command, tokenId);
    await publicClient.simulateContract({
      account: this.#options.account,
      address: this.#options.reputationRegistryAddress,
      abi: erc8004ReputationRegistryAbi,
      functionName: 'giveFeedback',
      args,
    });
    const data = encodeFunctionData({
      abi: erc8004ReputationRegistryAbi,
      functionName: 'giveFeedback',
      args,
    });
    const walletClient = this.#walletClient();
    const request = await walletClient.prepareTransactionRequest({
      account: this.#options.account,
      to: this.#options.reputationRegistryAddress,
      data,
    });
    const serializedTransaction = await walletClient.signTransaction(request);
    return {
      agentTokenId: tokenId.toString(),
      transactionHash: keccak256(serializedTransaction),
      serializedTransaction,
      contractAddress: this.#options.reputationRegistryAddress,
      identityRegistryAddress: this.#options.identityRegistryAddress,
      signerAddress: this.signerAddress,
    };
  }

  public async broadcastPreparedFeedback(prepared: PreparedErc8004Feedback): Promise<Hex> {
    if (
      prepared.contractAddress !== this.#options.reputationRegistryAddress
      || prepared.identityRegistryAddress !== this.#options.identityRegistryAddress
      || prepared.signerAddress !== this.signerAddress
      || keccak256(prepared.serializedTransaction) !== prepared.transactionHash
    ) throw new ChainConfigurationError('Prepared reputation transaction does not match this gateway.');
    const client = this.#publicClient();
    try {
      const hash = await client.sendRawTransaction({
        serializedTransaction: prepared.serializedTransaction,
      });
      if (hash !== prepared.transactionHash) {
        throw new EscrowAttestationError('RPC returned an unexpected reputation transaction hash.');
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

  public async confirmFeedback(
    command: Erc8004FeedbackCommand,
    prepared: PreparedErc8004Feedback,
  ): Promise<ConfirmedErc8004Feedback> {
    const { chainId, tokenId } = this.#validateCommand(command);
    if (
      chainId !== this.#options.chain.id
      || prepared.agentTokenId !== tokenId.toString()
      || prepared.signerAddress !== this.signerAddress
    ) throw new ChainConfigurationError('Prepared transaction does not match this feedback.');
    const client = this.#publicClient();
    const receipt = await client.waitForTransactionReceipt({
      hash: prepared.transactionHash,
      confirmations: this.#options.confirmations ?? 1,
    });
    if (receipt.status !== 'success') throw new ChainTransactionRevertedError(prepared.transactionHash);
    const [event] = parseEventLogs({
      abi: erc8004ReputationRegistryAbi,
      eventName: 'NewFeedback',
      logs: receipt.logs,
      strict: true,
    }).filter((entry) =>
      entry.args.agentId === tokenId
      && getAddress(entry.args.clientAddress) === this.signerAddress,
    );
    if (event === undefined) throw new EscrowAttestationError('Feedback event was not emitted.');
    const [value, valueDecimals, tag1, tag2, isRevoked] = await client.readContract({
      address: this.#options.reputationRegistryAddress,
      abi: erc8004ReputationRegistryAbi,
      functionName: 'readFeedback',
      args: [tokenId, this.signerAddress, event.args.feedbackIndex],
    });
    if (
      value !== command.value
      || valueDecimals !== command.valueDecimals
      || tag1 !== command.tag1
      || tag2 !== command.tag2
      || isRevoked
      || event.args.feedbackURI !== command.feedbackUri
      || event.args.feedbackHash.toLowerCase() !== command.feedbackHash.toLowerCase()
    ) throw new EscrowAttestationError('Confirmed reputation feedback does not match the request.');
    return {
      transactionHash: prepared.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      feedbackIndex: event.args.feedbackIndex.toString(),
      clientAddress: this.signerAddress,
    };
  }

  #validateCommand(command: Erc8004FeedbackCommand): { chainId: number; tokenId: bigint } {
    if (command.value < INT128_MIN || command.value > INT128_MAX) {
      throw new ChainConfigurationError('Reputation value is outside int128 range.');
    }
    if (!Number.isInteger(command.valueDecimals) || command.valueDecimals < 0 || command.valueDecimals > 18) {
      throw new ChainConfigurationError('Reputation value decimals must be between zero and eighteen.');
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(command.feedbackHash)) {
      throw new ChainConfigurationError('Reputation feedback hash must be bytes32.');
    }
    return parseAgentIdentity(command.providerAgentId);
  }

  #feedbackArgs(command: Erc8004FeedbackCommand, tokenId: bigint) {
    return [
      tokenId,
      command.value,
      command.valueDecimals,
      command.tag1,
      command.tag2,
      command.endpoint,
      command.feedbackUri,
      command.feedbackHash,
    ] as const;
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

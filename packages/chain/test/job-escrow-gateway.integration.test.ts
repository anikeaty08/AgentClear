import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createPublicClient,
  createWalletClient,
  bytesToHex,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseEther,
  stringToBytes,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentIdentityToHash,
  ESCROW_STATE,
  ViemErc8004ReputationGateway,
  ViemJobEscrowGateway,
  ViemOutcomeRegistryGateway,
} from '../src/index.js';

type JobEscrowArtifact = {
  abi: Abi;
  bytecode: { object: Hex };
};

const chainId = 31_337;
const artifactUrl = new URL(
  '../../contracts/out/JobEscrow.sol/JobEscrow.json',
  import.meta.url,
);
const outcomeArtifactUrl = new URL(
  '../../contracts/out/OutcomeRegistry.sol/OutcomeRegistry.json',
  import.meta.url,
);
const identityArtifactUrl = new URL(
  '../../contracts/out/TestErc8004Registries.sol/TestErc8004IdentityRegistry.json',
  import.meta.url,
);
const reputationArtifactUrl = new URL(
  '../../contracts/out/TestErc8004Registries.sol/TestErc8004ReputationRegistry.json',
  import.meta.url,
);

let anvil: ChildProcess | undefined;
let rpcUrl: string;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve an Anvil port.');
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForRpc(url: string, child: ChildProcess): Promise<void> {
  const probe = createPublicClient({ transport: http(url) });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Anvil exited before readiness with code ${child.exitCode}.`);
    }
    try {
      if ((await probe.getChainId()) === chainId) return;
    } catch {
      await delay(50);
    }
  }
  throw new Error('Anvil did not become ready before the integration-test timeout.');
}

async function readArtifact(url = artifactUrl): Promise<JobEscrowArtifact> {
  const parsed: unknown = JSON.parse(await readFile(url, 'utf8'));
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !('abi' in parsed)
    || !('bytecode' in parsed)
    || typeof parsed.bytecode !== 'object'
    || parsed.bytecode === null
    || !('object' in parsed.bytecode)
    || typeof parsed.bytecode.object !== 'string'
    || !parsed.bytecode.object.startsWith('0x')
  ) {
    throw new Error('The compiled contract artifact is invalid.');
  }
  return parsed as JobEscrowArtifact;
}

function createRandomSigner(): PrivateKeyAccount {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return privateKeyToAccount(bytesToHex(randomBytes(32)));
    } catch {
      // A uniformly random 32-byte value is retried if it falls outside the secp256k1 range.
    }
  }
  throw new Error('Could not generate a valid local integration-test signer.');
}

beforeAll(async () => {
  const port = await reservePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.env['ANVIL_PATH'] ?? 'anvil',
    [
      '--host',
      '127.0.0.1',
      '--port',
      port.toString(),
      '--chain-id',
      chainId.toString(),
      '--accounts',
      '3',
      '--mnemonic-random',
      '--hardfork',
      'cancun',
      '--silent',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  anvil = child;
  await waitForRpc(rpcUrl, child);
});

afterAll(async () => {
  if (anvil !== undefined && anvil.exitCode === null) {
    anvil.kill();
  }
});

describe('ViemJobEscrowGateway against Anvil', () => {
  it('deploys, funds, confirms, reads, and assigns through real transactions', async () => {
    const chain = defineChain({
      id: chainId,
      name: 'AgentClear Anvil',
      nativeCurrency: { name: 'Local 0G', symbol: 'A0GI', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const transport = http(rpcUrl);
    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ chain, transport });
    const [buyer, provider] = await walletClient.getAddresses();
    if (buyer === undefined || provider === undefined) {
      throw new Error('Anvil did not expose the required unlocked accounts.');
    }

    const localSigner = createRandomSigner();
    const signerFundingHash = await walletClient.sendTransaction({
      account: buyer,
      to: localSigner.address,
      value: parseEther('20'),
    });
    await publicClient.waitForTransactionReceipt({ hash: signerFundingHash });

    const artifact = await readArtifact();
    const deploymentHash = await walletClient.deployContract({
      account: buyer,
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [buyer, 0, localSigner.address, buyer, buyer, 250],
    });
    const deploymentReceipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
    const contractAddress = deploymentReceipt.contractAddress;
    if (deploymentReceipt.status !== 'success' || contractAddress === null || contractAddress === undefined) {
      throw new Error('JobEscrow deployment failed.');
    }

    const gateway = new ViemJobEscrowGateway({
      rpcUrl,
      chain,
      contractAddress,
      account: localSigner,
    });
    await expect(gateway.health()).resolves.toEqual({ chainId, contractDeployed: true });

    const jobId = '018f7f67-8d48-7c9f-8c5e-57a6a1f53b80';
    const agreementHash = keccak256(stringToBytes('canonical-agreement'));
    const amount = parseEther('2');
    const deadline = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const command = {
      jobId,
      agreementHash,
      amountBaseUnits: amount.toString(),
      deadline,
    } as const;
    const prepared = await gateway.prepareFundJob(command);
    expect(prepared.signerAddress).toBe(localSigner.address);
    await expect(gateway.broadcastPreparedFunding(prepared)).resolves.toBe(
      prepared.transactionHash,
    );
    await expect(gateway.broadcastPreparedFunding(prepared)).resolves.toBe(
      prepared.transactionHash,
    );
    const funded = await gateway.confirmFundJob(command, prepared);

    expect(funded.escrow.buyer).toBe(localSigner.address);
    expect(funded.escrow.provider).toBeNull();
    expect(funded.escrow.amountBaseUnits).toBe(amount.toString());
    expect(funded.escrow.state).toBe(ESCROW_STATE.FUNDED);
    expect(funded.escrow.agreementHash).toBe(agreementHash);

    const fundingTransaction = await publicClient.getTransaction({
      hash: funded.transactionHash,
    });
    expect(fundingTransaction.to).toBe(contractAddress);
    expect(fundingTransaction.value).toBe(amount);

    const preparedAssignment = await gateway.prepareAssignProvider(jobId, provider);
    await gateway.broadcastPreparedTransaction(preparedAssignment);
    const assignment = await gateway.confirmAssignProvider(jobId, provider, preparedAssignment);
    expect(assignment.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    const assignedEscrow = await gateway.getEscrow(jobId);
    expect(assignedEscrow.provider).toBe(getAddress(provider) as Address);
    expect(assignedEscrow.state).toBe(ESCROW_STATE.FUNDED);

    const outcomeArtifact = await readArtifact(outcomeArtifactUrl);
    const outcomeDeploymentHash = await walletClient.deployContract({
      account: buyer,
      abi: outcomeArtifact.abi,
      bytecode: outcomeArtifact.bytecode.object,
      args: [buyer, 0, localSigner.address],
    });
    const outcomeDeployment = await publicClient.waitForTransactionReceipt({
      hash: outcomeDeploymentHash,
    });
    const outcomeAddress = outcomeDeployment.contractAddress;
    if (outcomeDeployment.status !== 'success' || outcomeAddress === null || outcomeAddress === undefined) {
      throw new Error('OutcomeRegistry deployment failed.');
    }
    const outcomeGateway = new ViemOutcomeRegistryGateway({
      rpcUrl,
      chain,
      contractAddress: outcomeAddress,
      account: localSigner,
    });
    await expect(outcomeGateway.health()).resolves.toEqual({ chainId, contractDeployed: true });
    const outcomeCommand = {
      jobId,
      agreementHash,
      submissionHash: keccak256(stringToBytes('submission')),
      verificationReportHash: keccak256(stringToBytes('verification-report')),
      buyerAgentId: 'erc8004:16602:123',
      providerAgentId: 'erc8004:16602:456',
      outcome: 'PASS',
    } as const;
    const preparedOutcome = await outcomeGateway.prepareRecordOutcome(outcomeCommand);
    await expect(outcomeGateway.broadcastPreparedOutcome(preparedOutcome)).resolves.toBe(
      preparedOutcome.transactionHash,
    );
    await expect(outcomeGateway.broadcastPreparedOutcome(preparedOutcome)).resolves.toBe(
      preparedOutcome.transactionHash,
    );
    const confirmedOutcome = await outcomeGateway.confirmRecordOutcome(
      outcomeCommand,
      preparedOutcome,
    );
    expect(confirmedOutcome.record).toMatchObject({
      agreementHash,
      submissionHash: outcomeCommand.submissionHash,
      verificationReportHash: outcomeCommand.verificationReportHash,
      buyerIdentityHash: agentIdentityToHash(outcomeCommand.buyerAgentId),
      providerIdentityHash: agentIdentityToHash(outcomeCommand.providerAgentId),
      outcome: 'PASS',
    });

    const settlementCommand = {
      jobId,
      verificationReportHash: outcomeCommand.verificationReportHash,
    };
    const preparedSettlement = await gateway.prepareSettle(settlementCommand);
    await gateway.broadcastPreparedTransaction(preparedSettlement);
    const settlement = await gateway.confirmSettle(settlementCommand, preparedSettlement);
    expect(settlement.escrow.state).toBe(ESCROW_STATE.RELEASED);

    const identityArtifact = await readArtifact(identityArtifactUrl);
    const identityDeploymentHash = await walletClient.deployContract({
      account: buyer,
      abi: identityArtifact.abi,
      bytecode: identityArtifact.bytecode.object,
    });
    const identityDeployment = await publicClient.waitForTransactionReceipt({
      hash: identityDeploymentHash,
    });
    const identityAddress = identityDeployment.contractAddress;
    if (identityDeployment.status !== 'success' || identityAddress === null || identityAddress === undefined) {
      throw new Error('Test ERC-8004 IdentityRegistry deployment failed.');
    }
    const registerHash = await walletClient.writeContract({
      account: buyer,
      address: identityAddress,
      abi: identityArtifact.abi,
      functionName: 'setOwner',
      args: [456n, provider],
    });
    await publicClient.waitForTransactionReceipt({ hash: registerHash });
    const reputationArtifact = await readArtifact(reputationArtifactUrl);
    const reputationDeploymentHash = await walletClient.deployContract({
      account: buyer,
      abi: reputationArtifact.abi,
      bytecode: reputationArtifact.bytecode.object,
      args: [identityAddress],
    });
    const reputationDeployment = await publicClient.waitForTransactionReceipt({
      hash: reputationDeploymentHash,
    });
    const reputationAddress = reputationDeployment.contractAddress;
    if (
      reputationDeployment.status !== 'success'
      || reputationAddress === null
      || reputationAddress === undefined
    ) throw new Error('Test ERC-8004 ReputationRegistry deployment failed.');
    const reputationGateway = new ViemErc8004ReputationGateway({
      rpcUrl,
      chain,
      identityRegistryAddress: identityAddress,
      reputationRegistryAddress: reputationAddress,
      account: localSigner,
    });
    await expect(reputationGateway.health()).resolves.toEqual({
      chainId,
      identityRegistryLinked: true,
      contractsDeployed: true,
    });
    const selfOwnedIdentityHash = await walletClient.writeContract({
      account: buyer,
      address: identityAddress,
      abi: identityArtifact.abi,
      functionName: 'setOwner',
      args: [999n, localSigner.address],
    });
    await publicClient.waitForTransactionReceipt({ hash: selfOwnedIdentityHash });
    await expect(reputationGateway.prepareFeedback({
      providerAgentId: `erc8004:${chainId}:999`,
      value: 100n,
      valueDecimals: 0,
      tag1: 'agentclear.outcome',
      tag2: 'code',
      endpoint: '',
      feedbackUri: `0g://${outcomeCommand.verificationReportHash}`,
      feedbackHash: zeroHash,
    })).rejects.toThrow('feedback signer cannot own the provider identity');
    const feedbackCommand = {
      providerAgentId: `erc8004:${chainId}:456`,
      value: 100n,
      valueDecimals: 0,
      tag1: 'agentclear.outcome',
      tag2: 'code',
      endpoint: '',
      feedbackUri: `0g://${outcomeCommand.verificationReportHash}`,
      feedbackHash: zeroHash,
    } as const;
    const preparedFeedback = await reputationGateway.prepareFeedback(feedbackCommand);
    await expect(reputationGateway.broadcastPreparedFeedback(preparedFeedback)).resolves.toBe(
      preparedFeedback.transactionHash,
    );
    await expect(reputationGateway.broadcastPreparedFeedback(preparedFeedback)).resolves.toBe(
      preparedFeedback.transactionHash,
    );
    await expect(
      reputationGateway.confirmFeedback(feedbackCommand, preparedFeedback),
    ).resolves.toMatchObject({ feedbackIndex: '1', clientAddress: localSigner.address });
  });
});

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ViemErc8004ReputationGateway,
  ViemJobEscrowGateway,
  ViemOutcomeRegistryGateway,
} from '@agentclear/chain';
import {
  createDatabaseClient,
  PostgresAssignmentRepository,
  PostgresEscrowRepository,
  PostgresJobRepository,
  PostgresReceiptRepository,
  PostgresReputationRepository,
  PostgresSpendingPolicyRepository,
  PostgresSubmissionRepository,
  PostgresVerificationRepository,
  PostgresSettlementRepository,
} from '@agentclear/db';
import {
  AssignmentService,
  FundingService,
  InMemoryExclusiveExecutor,
  JobService,
  ReceiptService,
  ReputationService,
  SpendingPolicyService,
  SubmissionQueryService,
  SubmissionService,
  VerificationQueryService,
  VerificationService,
  SettlementService,
  type EvidenceStore,
  type AiVerificationResult,
  type AiVerifier,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxVerifier,
} from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { BootstrapApiKeyAuthenticator, CompositeAuthenticator } from '../src/auth.js';

type JobEscrowArtifact = {
  abi: Abi;
  bytecode: { object: Hex };
};

const databaseUrl = process.env['DATABASE_URL'];
const chainId = 31_337;
const artifactUrl = new URL(
  '../../../packages/contracts/out/JobEscrow.sol/JobEscrow.json',
  import.meta.url,
);
const outcomeArtifactUrl = new URL(
  '../../../packages/contracts/out/OutcomeRegistry.sol/OutcomeRegistry.json',
  import.meta.url,
);
const identityRegistryArtifactUrl = new URL(
  '../../../packages/contracts/out/TestErc8004Registries.sol/TestErc8004IdentityRegistry.json',
  import.meta.url,
);
const reputationRegistryArtifactUrl = new URL(
  '../../../packages/contracts/out/TestErc8004Registries.sol/TestErc8004ReputationRegistry.json',
  import.meta.url,
);

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
    if (child.exitCode !== null) throw new Error(`Anvil exited with code ${child.exitCode}.`);
    try {
      if ((await probe.getChainId()) === chainId) return;
    } catch {
      await delay(50);
    }
  }
  throw new Error('Anvil did not become ready.');
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
      // Retry the negligible chance of generating a value outside the secp256k1 range.
    }
  }
  throw new Error('Could not generate a valid integration-test signer.');
}

class IntegrationEvidenceStorage implements EvidenceStore {
  public calls = 0;
  readonly #objects = new Map<string, Uint8Array>();

  public async uploadVerified(data: Uint8Array) {
    this.calls += 1;
    const rootHash = `0x${createHash('sha256').update(data).digest('hex')}` as `0x${string}`;
    this.#objects.set(rootHash, new Uint8Array(data));
    return {
      rootHash,
      transactionHash: `0x${'e'.repeat(64)}` as const,
      transactionSequence: 10 + this.calls,
      sizeBytes: data.byteLength,
      verified: true as const,
    };
  }

  public async downloadVerified(rootHash: string): Promise<Uint8Array> {
    const stored = this.#objects.get(rootHash);
    if (stored === undefined) throw new Error('Test evidence root was not found.');
    return new Uint8Array(stored);
  }

  public reset(): void {
    this.calls = 0;
    this.#objects.clear();
  }
}

class ControlledIntegrationAiVerifier implements AiVerifier {
  public calls = 0;
  public failAfterDispatch = false;

  public async preflight(): Promise<void> {}

  public async evaluate(): Promise<AiVerificationResult> {
    this.calls += 1;
    if (this.failAfterDispatch) throw new Error('Controlled post-dispatch failure.');
    return {
      providerAddress: `0x${'c'.repeat(40)}`,
      model: 'controlled-integration-model',
      chatId: `controlled-chat-${this.calls}`,
      scoreBps: 9500,
      confidenceBps: 9000,
      criteria: [
        {
          id: 'quality',
          scoreBps: 9500,
          confidenceBps: 9000,
          explanation: 'The controlled test response satisfies the configured rubric.',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      rawResponse: '{"scoreBps":9500,"confidenceBps":9000}',
      responseVerified: true,
    };
  }

  public reset(): void {
    this.calls = 0;
    this.failAfterDispatch = false;
  }
}

class ControlledIntegrationSandboxVerifier implements SandboxVerifier {
  public calls = 0;
  public lastRequest: SandboxExecutionRequest | null = null;

  public async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    this.calls += 1;
    this.lastRequest = request;
    return {
      exitCode: 0,
      stdoutSummary: JSON.stringify({ testCount: request.testVectors.length }),
      stderrSummary: '',
      durationMs: 12,
      testCount: request.testVectors.length,
      passedTests: request.testVectors.length,
      failedTests: 0,
      timedOut: false,
      outputTruncated: false,
      outOfMemory: false,
      artifactHash: `0x${createHash('sha256').update(JSON.stringify(request.files)).digest('hex')}`,
    };
  }

  public reset(): void {
    this.calls = 0;
    this.lastRequest = null;
  }
}

describe.skipIf(databaseUrl === undefined)('AgentClear funding API with PostgreSQL and Anvil', () => {
  const database = createDatabaseClient(databaseUrl!);
  const spendingPolicyRepository = new PostgresSpendingPolicyRepository(database.db);
  const spendingPolicyService = new SpendingPolicyService({
    repository: spendingPolicyRepository,
  });
  const apiKey = 'funding-integration-api-key-at-least-32-chars';
  const providerApiKey = 'provider-integration-api-key-at-least-32-chars';
  let anvil: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let publicClient: ReturnType<typeof createPublicClient>;
  let gateway: ViemJobEscrowGateway;
  let outcomeGateway: ViemOutcomeRegistryGateway;
  let reputationGateway: ViemErc8004ReputationGateway;
  let providerAddress: Address;
  const evidenceStorage = new IntegrationEvidenceStorage();
  const controlledAiVerifier = new ControlledIntegrationAiVerifier();
  const controlledSandboxVerifier = new ControlledIntegrationSandboxVerifier();

  beforeAll(async () => {
    const port = await reservePort();
    const rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(
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
    await waitForRpc(rpcUrl, anvil);

    const chain = defineChain({
      id: chainId,
      name: 'AgentClear API Anvil',
      nativeCurrency: { name: 'Local 0G', symbol: 'A0GI', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const transport = http(rpcUrl);
    publicClient = createPublicClient({ chain, transport });
    const unlockedWallet = createWalletClient({ chain, transport });
    const [deployer, provider] = await unlockedWallet.getAddresses();
    if (deployer === undefined || provider === undefined) {
      throw new Error('Anvil did not expose the required accounts.');
    }
    providerAddress = provider;

    const signer = createRandomSigner();
    const signerFundingHash = await unlockedWallet.sendTransaction({
      account: deployer,
      to: signer.address,
      value: parseEther('10'),
    });
    await publicClient.waitForTransactionReceipt({ hash: signerFundingHash });

    const artifact = await readArtifact();
    const deploymentHash = await unlockedWallet.deployContract({
      account: deployer,
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [deployer, 0, signer.address, deployer, deployer, 250],
    });
    const deploymentReceipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
    const contractAddress = deploymentReceipt.contractAddress;
    if (deploymentReceipt.status !== 'success' || contractAddress === undefined || contractAddress === null) {
      throw new Error('JobEscrow deployment failed.');
    }
    const outcomeArtifact = await readArtifact(outcomeArtifactUrl);
    const outcomeDeploymentHash = await unlockedWallet.deployContract({
      account: deployer,
      abi: outcomeArtifact.abi,
      bytecode: outcomeArtifact.bytecode.object,
      args: [deployer, 0, signer.address],
    });
    const outcomeDeployment = await publicClient.waitForTransactionReceipt({
      hash: outcomeDeploymentHash,
    });
    const outcomeContractAddress = outcomeDeployment.contractAddress;
    if (
      outcomeDeployment.status !== 'success'
      || outcomeContractAddress === undefined
      || outcomeContractAddress === null
    ) throw new Error('OutcomeRegistry deployment failed.');

    const identityArtifact = await readArtifact(identityRegistryArtifactUrl);
    const identityDeploymentHash = await unlockedWallet.deployContract({
      account: deployer,
      abi: identityArtifact.abi,
      bytecode: identityArtifact.bytecode.object,
    });
    const identityDeployment = await publicClient.waitForTransactionReceipt({
      hash: identityDeploymentHash,
    });
    const identityRegistryAddress = identityDeployment.contractAddress;
    if (
      identityDeployment.status !== 'success'
      || identityRegistryAddress === undefined
      || identityRegistryAddress === null
    ) throw new Error('Test ERC-8004 IdentityRegistry deployment failed.');
    const setOwnerHash = await unlockedWallet.writeContract({
      account: deployer,
      address: identityRegistryAddress,
      abi: identityArtifact.abi,
      functionName: 'setOwner',
      args: [456n, providerAddress],
    });
    await publicClient.waitForTransactionReceipt({ hash: setOwnerHash });

    const reputationArtifact = await readArtifact(reputationRegistryArtifactUrl);
    const reputationDeploymentHash = await unlockedWallet.deployContract({
      account: deployer,
      abi: reputationArtifact.abi,
      bytecode: reputationArtifact.bytecode.object,
      args: [identityRegistryAddress],
    });
    const reputationDeployment = await publicClient.waitForTransactionReceipt({
      hash: reputationDeploymentHash,
    });
    const reputationRegistryAddress = reputationDeployment.contractAddress;
    if (
      reputationDeployment.status !== 'success'
      || reputationRegistryAddress === undefined
      || reputationRegistryAddress === null
    ) throw new Error('Test ERC-8004 ReputationRegistry deployment failed.');

    const jobRepository = new PostgresJobRepository(database.db);
    const submissionRepository = new PostgresSubmissionRepository(database.db);
    const verificationRepository = new PostgresVerificationRepository(database.db);
    const settlementRepository = new PostgresSettlementRepository(database.db);
    gateway = new ViemJobEscrowGateway({ rpcUrl, chain, contractAddress, account: signer });
    outcomeGateway = new ViemOutcomeRegistryGateway({
      rpcUrl,
      chain,
      contractAddress: outcomeContractAddress,
      account: signer,
    });
    reputationGateway = new ViemErc8004ReputationGateway({
      rpcUrl,
      chain,
      identityRegistryAddress,
      reputationRegistryAddress,
      account: signer,
    });
    const chainWriteExecutor = new InMemoryExclusiveExecutor();
    app = await buildApp({
      jobRepository,
      jobService: new JobService({ repository: jobRepository }),
      submissionQueryService: new SubmissionQueryService(
        jobRepository,
        submissionRepository,
      ),
      verificationQueryService: new VerificationQueryService(
        jobRepository,
        verificationRepository,
      ),
      submissionService: new SubmissionService({
        jobRepository,
        submissionRepository,
        storage: evidenceStorage,
        maxPayloadBytes: 262_144,
        executor: chainWriteExecutor,
      }),
      verificationService: new VerificationService({
        jobRepository,
        submissionRepository,
        verificationRepository,
        storage: evidenceStorage,
        maxReportBytes: 262_144,
        aiVerifier: controlledAiVerifier,
        sandboxVerifier: controlledSandboxVerifier,
        executor: chainWriteExecutor,
      }),
      settlementService: new SettlementService({
        jobRepository,
        submissionRepository,
        verificationRepository,
        settlementRepository,
        outcomeGateway,
        escrowGateway: gateway,
        executor: chainWriteExecutor,
      }),
      reputationService: new ReputationService({
        jobRepository,
        verificationRepository,
        reputationRepository: new PostgresReputationRepository(database.db),
        gateway: reputationGateway,
        executor: chainWriteExecutor,
      }),
      receiptService: new ReceiptService({
        repository: new PostgresReceiptRepository(database.db),
        storage: evidenceStorage,
        maxPayloadBytes: 262_144,
        executor: chainWriteExecutor,
      }),
      fundingService: new FundingService({
        jobRepository,
        escrowRepository: new PostgresEscrowRepository(database.db),
        gateway,
        maxPerJobBaseUnits: parseEther('1').toString(),
        spendingAuthorizer: spendingPolicyRepository,
        executor: chainWriteExecutor,
      }),
      spendingPolicyService,
      assignmentService: new AssignmentService({
        jobRepository,
        assignmentRepository: new PostgresAssignmentRepository(database.db),
        gateway,
        executor: chainWriteExecutor,
      }),
      chainHealth: async () => ({
        escrow: await gateway.health(),
        outcomeRegistry: await outcomeGateway.health(),
        erc8004: await reputationGateway.health(),
      }),
      authenticator: new CompositeAuthenticator([
        new BootstrapApiKeyAuthenticator(
          apiKey,
          'funding-integration-pepper-at-least-32-chars',
          'operator_funding_it',
        ),
        new BootstrapApiKeyAuthenticator(
          providerApiKey,
          'funding-integration-pepper-at-least-32-chars',
          'erc8004:31337:456',
          'agent',
          new Set(['jobs:read', 'jobs:submit']),
        ),
      ]),
    });
  });

  beforeEach(async () => {
    evidenceStorage.reset();
    controlledAiVerifier.reset();
    controlledSandboxVerifier.reset();
    await database.db.execute(
      sql`truncate table funding_authorizations, spending_policies, receipts, receipt_operations, reputation_events, reputation_operations, settlements, refunds, settlement_operations, verification_reports, verification_checks, verification_runs, verification_operations, submission_artifacts, submissions, submission_operations, job_assignment_operations, job_assignments, escrow_funding_operations, escrows, idempotency_records, job_state_events, job_requirements, jobs`,
    );
    await spendingPolicyService.putPolicy(
      'operator_funding_it',
      {
        principalKind: 'operator',
        maxPerJobBaseUnits: parseEther('1').toString(),
        maxPerDayBaseUnits: parseEther('2').toString(),
        maxPerMonthBaseUnits: parseEther('10').toString(),
        allowedCapabilities: ['code', 'data', 'research'],
        requireHumanApprovalAboveBaseUnits: null,
      },
      {
        id: 'operator_funding_it',
        kind: 'operator',
        scopes: new Set(['spending-policies:manage']),
      },
    );
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await database.close();
    if (anvil !== undefined && anvil.exitCode === null) anvil.kill();
  });

  it('creates, funds, assigns, submits, and deterministically verifies through local boundaries', async () => {
    const authorization = `Bearer ${apiKey}`;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: {
        buyerAgentId: 'erc8004:31337:123',
        title: 'Implement transaction sorter',
        description: 'Implement the requested TypeScript function.',
        budget: { token: 'native', maxAmount: '0.5' },
        deadline: '2030-08-23T16:00:00.000Z',
        deliverable: { type: 'code', format: 'esm_files' },
        verification: {
          mode: 'deterministic',
          minimumScore: 1,
          requirements: ['The isolated addition test vectors must all pass.'],
          deterministicChecks: [
            {
              id: 'isolated-tests',
              kind: 'sandbox_tests',
              description: 'Execute the agreed vectors in the isolated runtime.',
        runtime: 'node24',
              entryFile: 'solution.mjs',
              exportName: 'add',
              testVectors: [
                { id: 'positive', input: { a: 2, b: 3 }, expected: 5 },
                { id: 'negative', input: { a: -2, b: 1 }, expected: -1 },
              ],
              weightBps: 10_000,
              hardFailure: true,
            },
          ],
        },
        refundPolicy: { onExpiry: true, onFinalFailure: true },
      },
    });
    const jobId = created.json().data.job.id as string;
    const quoted = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/quote`,
      headers: { authorization, 'idempotency-key': randomUUID() },
    });
    expect(quoted.statusCode).toBe(200);

    const fundingKey = randomUUID();
    const funded = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/fund`,
      headers: { authorization, 'idempotency-key': fundingKey },
      payload: {},
    });
    const replayed = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/fund`,
      headers: { authorization, 'idempotency-key': fundingKey },
      payload: {},
    });

    expect(funded.statusCode).toBe(200);
    expect(funded.json().data.job.state).toBe('FUNDED');
    expect(funded.json().data.funding).toMatchObject({
      status: 'CONFIRMED',
      amountBaseUnits: parseEther('0.5').toString(),
      transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      blockNumber: expect.any(String),
    });
    expect(funded.body).not.toContain('serializedTransaction');
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(replayed.json().data.funding.transactionHash).toBe(
      funded.json().data.funding.transactionHash,
    );

    const transaction = await publicClient.getTransaction({
      hash: funded.json().data.funding.transactionHash as Hex,
    });
    expect(transaction.value).toBe(parseEther('0.5'));

    const assignmentKey = randomUUID();
    const assigned = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/assign`,
      headers: { authorization, 'idempotency-key': assignmentKey },
      payload: {
        providerAgentId: 'erc8004:31337:456',
        providerAddress,
      },
    });
    const assignmentReplay = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/assign`,
      headers: { authorization, 'idempotency-key': assignmentKey },
      payload: {
        providerAgentId: 'erc8004:31337:456',
        providerAddress,
      },
    });

    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().data.job).toMatchObject({
      state: 'ASSIGNED',
      providerAgentId: 'erc8004:31337:456',
    });
    expect(assigned.json().data.assignment).toMatchObject({
      status: 'CONFIRMED',
      providerAgentId: 'erc8004:31337:456',
      providerAddress,
      transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      blockNumber: expect.any(String),
    });
    expect(assigned.body).not.toContain('serializedTransaction');
    expect(assignmentReplay.headers['idempotency-replayed']).toBe('true');
    expect(assignmentReplay.json().data.assignment.transactionHash).toBe(
      assigned.json().data.assignment.transactionHash,
    );

    const chainEscrow = await gateway.getEscrow(jobId);
    expect(chainEscrow.provider).toBe(providerAddress);

    const submissionKey = randomUUID();
    const providerAuthorization = `Bearer ${providerApiKey}`;
    const submissionPayload = {
      result: {
        files: {
          'solution.mjs': 'export function add({ a, b }) { return a + b; }',
        },
      },
    };
    const unauthorizedSubmission = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/submissions`,
      headers: {
        authorization,
        'idempotency-key': randomUUID(),
      },
      payload: submissionPayload,
    });
    expect(unauthorizedSubmission.statusCode).toBe(403);
    expect(unauthorizedSubmission.json().error.code).toBe('PROVIDER_NOT_AUTHORIZED');

    const submitted = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/submissions`,
      headers: {
        authorization: providerAuthorization,
        'idempotency-key': submissionKey,
      },
      payload: submissionPayload,
    });
    const submissionReplay = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/submissions`,
      headers: {
        authorization: providerAuthorization,
        'idempotency-key': submissionKey,
      },
      payload: submissionPayload,
    });
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}/submissions`,
      headers: { authorization },
    });

    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().data.job.state).toBe('SUBMITTED');
    expect(submitted.json().data.submission).toMatchObject({
      providerAgentId: 'erc8004:31337:456',
      storageRootHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      storageTransactionHash: `0x${'e'.repeat(64)}`,
      storageTransactionSequence: 11,
    });
    expect(submitted.body).not.toContain('canonicalPayload');
    expect(submissionReplay.headers['idempotency-replayed']).toBe('true');
    expect(evidenceStorage.calls).toBe(1);
    expect(listed.json().data.submissions).toHaveLength(1);

    const verificationKey = randomUUID();
    const verified = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/verify`,
      headers: { authorization, 'idempotency-key': verificationKey },
      payload: {},
    });
    const verificationReplay = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/verify`,
      headers: { authorization, 'idempotency-key': verificationKey },
      payload: {},
    });
    const verifications = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}/verifications`,
      headers: { authorization },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data.job.state).toBe('PASSED');
    expect(verified.json().data.verification).toMatchObject({
      outcome: 'PASS',
      scoreBps: 10_000,
      reportStorageRootHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      checks: [
        {
          id: 'isolated-tests',
          kind: 'sandbox_tests',
          passed: true,
          actual: {
            exitCode: 0,
            testCount: 2,
            passedTests: 2,
            failedTests: 0,
          },
        },
      ],
    });
    expect(verificationReplay.headers['idempotency-replayed']).toBe('true');
    expect(verifications.json().data.verifications).toHaveLength(1);
    expect(evidenceStorage.calls).toBe(2);
    expect(controlledSandboxVerifier.calls).toBe(1);
    expect(controlledSandboxVerifier.lastRequest).toMatchObject({
      entryFile: 'solution.mjs',
      exportName: 'add',
    });

    const settlementKey = randomUUID();
    const settled = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/settle`,
      headers: { authorization, 'idempotency-key': settlementKey },
      payload: {},
    });
    const settlementReplay = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/settle`,
      headers: { authorization, 'idempotency-key': settlementKey },
      payload: {},
    });
    const reputationReplay = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/reputation`,
      headers: { authorization, 'idempotency-key': settlementKey },
      payload: {},
    });
    expect(settled.statusCode).toBe(200);
    expect(settlementReplay.statusCode, settlementReplay.body).toBe(200);
    expect(settled.json().data.job.state).toBe('PAID');
    expect(settled.json().data.finalization).toMatchObject({
      kind: 'PAYMENT',
      amountBaseUnits: parseEther('0.5').toString(),
      outcomeTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      escrowTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(settled.json().data.reputation).toMatchObject({
      providerAgentId: 'erc8004:31337:456',
      agentTokenId: '456',
      value: '100',
      valueDecimals: 0,
      tag1: 'agentclear.outcome',
      tag2: 'code',
      transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      blockNumber: expect.any(String),
      feedbackIndex: expect.stringMatching(/^\d+$/),
    });
    expect(settled.json().data.receipt).toMatchObject({
      id: expect.any(String),
      jobId,
      receiptHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      storageRef: expect.stringMatching(/^0g:\/\/0x[0-9a-f]{64}$/),
      receipt: {
        jobId,
        buyerAgent: 'erc8004:31337:123',
        providerAgent: 'erc8004:31337:456',
        verification: { outcome: 'PASS' },
        settlement: { kind: 'PAYMENT' },
        reputation: { value: '100' },
      },
    });
    expect(settled.body).not.toContain('serializedTransaction');
    expect(settled.body).not.toContain('canonicalPayload');
    expect(settlementReplay.headers['idempotency-replayed']).toBe('true');
    expect(reputationReplay.statusCode, reputationReplay.body).toBe(200);
    expect(reputationReplay.headers['idempotency-replayed']).toBe('true');
    expect(reputationReplay.json().data.reputation.transactionHash).toBe(
      settled.json().data.reputation.transactionHash,
    );
    const receiptId = settled.json().data.receipt.id as string;
    const receipt = await app.inject({
      method: 'GET',
      url: `/v1/receipts/${receiptId}`,
      headers: { authorization },
    });
    const receiptForJob = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}/receipt`,
      headers: { authorization },
    });
    const receiptDownload = await app.inject({
      method: 'GET',
      url: `/v1/receipts/${receiptId}/download`,
      headers: { authorization },
    });
    const receiptRecovery = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/receipt`,
      headers: { authorization, 'idempotency-key': settlementKey },
      payload: {},
    });
    expect(receipt.statusCode).toBe(200);
    expect(receiptForJob.statusCode).toBe(200);
    expect(receiptForJob.json().data.receipt.id).toBe(receiptId);
    expect(receiptDownload.statusCode).toBe(200);
    expect(receiptDownload.headers['content-disposition']).toContain(receiptId);
    expect(JSON.parse(receiptDownload.body).receiptId).toBe(receiptId);
    expect(`0x${createHash('sha256').update(receiptDownload.body).digest('hex')}`).toBe(
      settled.json().data.receipt.receiptHash,
    );
    expect(receiptRecovery.statusCode).toBe(200);
    expect(receiptRecovery.headers['idempotency-replayed']).toBe('true');
    expect(evidenceStorage.calls).toBe(3);
    expect((await gateway.getEscrow(jobId)).state).toBe(3);
    expect(await outcomeGateway.getOutcome(jobId)).toMatchObject({ outcome: 'PASS' });
    const duplicateSettlement = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/settle`,
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: {},
    });
    expect(duplicateSettlement.statusCode).toBe(409);
    expect(duplicateSettlement.json().error.code).toBe('JOB_NOT_SETTLEABLE');

    const persisted = await database.db.execute<{
      state: string;
      events: string;
      submissions: string;
      artifacts: string;
      payload: string | null;
      verificationRuns: string;
      verificationChecks: string;
      verificationReports: string;
      reportPayload: string | null;
      settlements: string;
      refunds: string;
      settlementPayloads: string;
      reputationEvents: string;
      reputationPayloads: string;
      receipts: string;
      receiptPayloads: string;
    }>(sql`
      select
        (select state::text from jobs where id = ${jobId}) as state,
        (select count(*)::text from job_state_events where job_id = ${jobId}) as events,
        (select count(*)::text from submissions where job_id = ${jobId}) as submissions,
        (select count(*)::text from submission_artifacts where submission_id in (
          select id from submissions where job_id = ${jobId}
        )) as artifacts,
        (select canonical_payload from submission_operations where job_id = ${jobId}) as payload,
        (select count(*)::text from verification_runs where job_id = ${jobId}) as "verificationRuns",
        (select count(*)::text from verification_checks where run_id in (
          select id from verification_runs where job_id = ${jobId}
        )) as "verificationChecks",
        (select count(*)::text from verification_reports where run_id in (
          select id from verification_runs where job_id = ${jobId}
        )) as "verificationReports",
        (select canonical_report from verification_operations where job_id = ${jobId}) as "reportPayload"
        ,(select count(*)::text from settlements where job_id = ${jobId}) as settlements
        ,(select count(*)::text from refunds where job_id = ${jobId}) as refunds
        ,(select count(*)::text from settlement_operations where job_id = ${jobId}
          and outcome_serialized_transaction is null and escrow_serialized_transaction is null
        ) as "settlementPayloads"
        ,(select count(*)::text from reputation_events where job_id = ${jobId}) as "reputationEvents"
        ,(select count(*)::text from reputation_operations where job_id = ${jobId}
          and serialized_transaction is null
        ) as "reputationPayloads"
        ,(select count(*)::text from receipts where job_id = ${jobId}) as receipts
        ,(select count(*)::text from receipt_operations where job_id = ${jobId}
          and canonical_payload is null
        ) as "receiptPayloads"
    `);
    expect(persisted.rows[0]).toEqual({
      state: 'PAID',
      events: '11',
      submissions: '1',
      artifacts: '1',
      payload: null,
      verificationRuns: '1',
      verificationChecks: '1',
      verificationReports: '1',
      reportPayload: null,
      settlements: '1',
      refunds: '0',
      settlementPayloads: '1',
      reputationEvents: '1',
      reputationPayloads: '1',
      receipts: '1',
      receiptPayloads: '1',
    });
  });

  it('anchors a deterministic failure and refunds escrow exactly once', async () => {
    const authorization = `Bearer ${apiKey}`;
    const providerAuthorization = `Bearer ${providerApiKey}`;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: {
        buyerAgentId: 'erc8004:31337:123',
        title: 'Return an accepted result',
        description: 'The provider must explicitly return an accepted result.',
        budget: { token: 'native', maxAmount: '0.25' },
        deadline: '2030-08-23T16:00:00.000Z',
        deliverable: { type: 'data', format: 'application/json' },
        verification: {
          mode: 'deterministic',
          minimumScore: 1,
          requirements: ['The accepted field must be true.'],
          deterministicChecks: [{
            id: 'accepted',
            kind: 'json_path_equals',
            description: 'The result was accepted.',
            path: ['accepted'],
            expected: true,
            weightBps: 10_000,
            hardFailure: true,
          }],
        },
        refundPolicy: { onExpiry: true, onFinalFailure: true },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().data.job.id as string;

    const quoted = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/quote`,
      headers: { authorization, 'idempotency-key': randomUUID() },
    });
    expect(quoted.statusCode).toBe(200);
    const funded = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/fund`,
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: {},
    });
    expect(funded.statusCode, funded.body).toBe(200);
    const assigned = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/assign`,
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: {
        providerAgentId: 'erc8004:31337:456',
        providerAddress,
      },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const submitted = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/submissions`,
      headers: {
        authorization: providerAuthorization,
        'idempotency-key': randomUUID(),
      },
      payload: { result: { accepted: false } },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const verified = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/verify`,
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: {},
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data).toMatchObject({
      job: { state: 'FAILED' },
      verification: { outcome: 'FAIL', scoreBps: 0 },
    });

    const settlementKey = randomUUID();
    const refunded = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/settle`,
      headers: { authorization, 'idempotency-key': settlementKey },
      payload: {},
    });
    const replayed = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/settle`,
      headers: { authorization, 'idempotency-key': settlementKey },
      payload: {},
    });
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(refunded.json().data).toMatchObject({
      job: { state: 'REFUNDED' },
      finalization: {
        kind: 'REFUND',
        amountBaseUnits: parseEther('0.25').toString(),
        outcomeTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        escrowTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      },
      reputation: {
        providerAgentId: 'erc8004:31337:456',
        agentTokenId: '456',
        value: '0',
        valueDecimals: 0,
        tag1: 'agentclear.outcome',
        tag2: 'data',
        transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        feedbackIndex: expect.stringMatching(/^\d+$/),
      },
      receipt: {
        jobId,
        receipt: {
          verification: { outcome: 'FAIL' },
          settlement: { kind: 'REFUND' },
          reputation: { value: '0' },
        },
      },
    });
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect((await gateway.getEscrow(jobId)).state).toBe(4);
    expect(await outcomeGateway.getOutcome(jobId)).toMatchObject({ outcome: 'FAIL' });
    expect(evidenceStorage.calls).toBe(3);

    const persisted = await database.db.execute<{
      settlements: string;
      refunds: string;
      events: string;
      reputationEvents: string;
      receipts: string;
    }>(sql`
      select
        (select count(*)::text from settlements where job_id = ${jobId}) as settlements,
        (select count(*)::text from refunds where job_id = ${jobId}) as refunds,
        (select count(*)::text from job_state_events where job_id = ${jobId}) as events,
        (select count(*)::text from reputation_events where job_id = ${jobId}) as "reputationEvents",
        (select count(*)::text from receipts where job_id = ${jobId}) as receipts
    `);
    expect(persisted.rows[0]).toEqual({
      settlements: '0',
      refunds: '1',
      events: '11',
      reputationEvents: '1',
      receipts: '1',
    });
  });

  it('persists a controlled AI rubric signal and never repeats the paid boundary on replay', async () => {
    const authorization = `Bearer ${apiKey}`;
    const providerAuthorization = `Bearer ${providerApiKey}`;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: {
        buyerAgentId: 'erc8004:31337:123',
        title: 'Review a structured research result',
        description: 'Evaluate the submitted research result against the committed rubric.',
        budget: { token: 'native', maxAmount: '0.1' },
        deadline: '2030-08-23T16:00:00.000Z',
        deliverable: { type: 'research', format: 'application/json' },
        verification: {
          mode: 'ai',
          minimumScore: 0.9,
          requirements: ['The result must be evidence-backed and complete.'],
          rubric: {
            criteria: [
              {
                id: 'quality',
                description: 'The result is evidence-backed and complete.',
                weightBps: 10_000,
              },
            ],
          },
        },
        refundPolicy: { onExpiry: true, onFinalFailure: true },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().data.job.id as string;
    expect((await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/quote`,
      headers: { authorization, 'idempotency-key': randomUUID() },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/fund`,
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: {},
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/assign`,
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: { providerAgentId: 'erc8004:31337:456', providerAddress },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/submissions`,
      headers: { authorization: providerAuthorization, 'idempotency-key': randomUUID() },
      payload: { result: { summary: 'Evidence-backed result.' } },
    })).statusCode).toBe(201);

    const verificationKey = randomUUID();
    const verified = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/verify`,
      headers: { authorization, 'idempotency-key': verificationKey },
      payload: {},
    });
    const replayed = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/verify`,
      headers: { authorization, 'idempotency-key': verificationKey },
      payload: {},
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data).toMatchObject({
      job: { state: 'PASSED' },
      verification: {
        outcome: 'PASS',
        scoreBps: 9500,
        verifierVersion: 'agentclear-verification-v2',
        ai: {
          providerAddress: `0x${'c'.repeat(40)}`,
          model: 'controlled-integration-model',
          responseVerified: true,
          scoreBps: 9500,
        },
      },
    });
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(controlledAiVerifier.calls).toBe(1);

    const persisted = await database.db.execute<{
      status: string;
      promptHash: string | null;
      aiResult: { model?: string } | null;
    }>(sql`
      select
        vo.status::text as status,
        vo.compute_prompt_hash as "promptHash",
        vr.ai_result as "aiResult"
      from verification_operations vo
      join verification_runs vr on vr.id = vo.run_id
      where vo.job_id = ${jobId}
    `);
    expect(persisted.rows[0]).toMatchObject({
      status: 'CONFIRMED',
      promptHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      aiResult: { model: 'controlled-integration-model' },
    });
  });

  it('requires reconciliation instead of repeating an ambiguous paid Compute request', async () => {
    const authorization = `Bearer ${apiKey}`;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: {
        buyerAgentId: 'erc8004:31337:123',
        title: 'Review an ambiguous paid result',
        description: 'Exercise paid-request crash recovery without a duplicate inference.',
        budget: { token: 'native', maxAmount: '0.1' },
        deadline: '2030-08-23T16:00:00.000Z',
        deliverable: { type: 'research', format: 'application/json' },
        verification: {
          mode: 'ai',
          minimumScore: 0.9,
          requirements: ['The result must be evidence-backed.'],
          rubric: {
            criteria: [
              {
                id: 'quality',
                description: 'The result is evidence-backed.',
                weightBps: 10_000,
              },
            ],
          },
        },
        refundPolicy: { onExpiry: true, onFinalFailure: true },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().data.job.id as string;
    expect((await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/quote`,
      headers: { authorization, 'idempotency-key': randomUUID() },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/fund`,
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: {},
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/assign`,
      headers: { authorization, 'idempotency-key': randomUUID() },
      payload: { providerAgentId: 'erc8004:31337:456', providerAddress },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/submissions`,
      headers: {
        authorization: `Bearer ${providerApiKey}`,
        'idempotency-key': randomUUID(),
      },
      payload: { result: { summary: 'Evidence-backed result.' } },
    })).statusCode).toBe(201);

    controlledAiVerifier.failAfterDispatch = true;
    const verificationKey = randomUUID();
    const interrupted = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/verify`,
      headers: { authorization, 'idempotency-key': verificationKey },
      payload: {},
    });
    const replayed = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/verify`,
      headers: { authorization, 'idempotency-key': verificationKey },
      payload: {},
    });
    expect(interrupted.statusCode, interrupted.body).toBe(502);
    expect(interrupted.json().error.code).toBe('COMPUTE_OPERATION_FAILED');
    expect(replayed.statusCode, replayed.body).toBe(409);
    expect(replayed.json().error.code).toBe('COMPUTE_RECONCILIATION_REQUIRED');
    expect(controlledAiVerifier.calls).toBe(1);

    const persisted = await database.db.execute<{
      state: string;
      status: string;
      promptHash: string | null;
      runs: string;
    }>(sql`
      select
        j.state::text as state,
        vo.status::text as status,
        vo.compute_prompt_hash as "promptHash",
        (select count(*)::text from verification_runs where job_id = ${jobId}) as runs
      from jobs j
      join verification_operations vo on vo.job_id = j.id
      where j.id = ${jobId}
    `);
    expect(persisted.rows[0]).toMatchObject({
      state: 'VERIFYING',
      status: 'COMPUTING',
      promptHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      runs: '0',
    });
  });
});

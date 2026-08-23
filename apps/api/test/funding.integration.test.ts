import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { ViemJobEscrowGateway } from '@agentclear/chain';
import {
  createDatabaseClient,
  PostgresAssignmentRepository,
  PostgresEscrowRepository,
  PostgresJobRepository,
  PostgresSubmissionRepository,
  PostgresVerificationRepository,
} from '@agentclear/db';
import {
  AssignmentService,
  FundingService,
  InMemoryExclusiveExecutor,
  JobService,
  SubmissionQueryService,
  SubmissionService,
  VerificationQueryService,
  VerificationService,
  type EvidenceStore,
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

async function readArtifact(): Promise<JobEscrowArtifact> {
  const parsed: unknown = JSON.parse(await readFile(artifactUrl, 'utf8'));
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
    throw new Error('The compiled JobEscrow artifact is invalid.');
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
    const rootHash = `0x${(this.calls === 1 ? 'd' : 'f').repeat(64)}` as `0x${string}`;
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
}

describe.skipIf(databaseUrl === undefined)('AgentClear funding API with PostgreSQL and Anvil', () => {
  const database = createDatabaseClient(databaseUrl!);
  const apiKey = 'funding-integration-api-key-at-least-32-chars';
  const providerApiKey = 'provider-integration-api-key-at-least-32-chars';
  let anvil: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let publicClient: ReturnType<typeof createPublicClient>;
  let gateway: ViemJobEscrowGateway;
  let providerAddress: Address;
  const evidenceStorage = new IntegrationEvidenceStorage();

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
      args: [deployer, 0, deployer, deployer, deployer, 250],
    });
    const deploymentReceipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
    const contractAddress = deploymentReceipt.contractAddress;
    if (deploymentReceipt.status !== 'success' || contractAddress === undefined || contractAddress === null) {
      throw new Error('JobEscrow deployment failed.');
    }

    const jobRepository = new PostgresJobRepository(database.db);
    const submissionRepository = new PostgresSubmissionRepository(database.db);
    const verificationRepository = new PostgresVerificationRepository(database.db);
    gateway = new ViemJobEscrowGateway({ rpcUrl, chain, contractAddress, account: signer });
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
        executor: chainWriteExecutor,
      }),
      fundingService: new FundingService({
        jobRepository,
        escrowRepository: new PostgresEscrowRepository(database.db),
        gateway,
        maxPerJobBaseUnits: parseEther('1').toString(),
        executor: chainWriteExecutor,
      }),
      assignmentService: new AssignmentService({
        jobRepository,
        assignmentRepository: new PostgresAssignmentRepository(database.db),
        gateway,
        executor: chainWriteExecutor,
      }),
      chainHealth: async () => gateway.health(),
      authenticator: new CompositeAuthenticator([
        new BootstrapApiKeyAuthenticator(
          apiKey,
          'funding-integration-pepper-at-least-32-chars',
          'operator_funding_it',
        ),
        new BootstrapApiKeyAuthenticator(
          providerApiKey,
          'funding-integration-pepper-at-least-32-chars',
          'erc8004:16602:456',
          'agent',
          new Set(['jobs:read', 'jobs:submit']),
        ),
      ]),
    });
  });

  beforeEach(async () => {
    await database.db.execute(
      sql`truncate table verification_reports, verification_checks, verification_runs, verification_operations, submission_artifacts, submissions, submission_operations, job_assignment_operations, job_assignments, escrow_funding_operations, escrows, idempotency_records, job_state_events, job_requirements, jobs`,
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
        buyerAgentId: 'erc8004:16602:123',
        title: 'Implement transaction sorter',
        description: 'Implement the requested TypeScript function.',
        budget: { token: 'native', maxAmount: '0.5' },
        deadline: '2030-08-23T16:00:00.000Z',
        deliverable: { type: 'code', format: 'git_patch' },
        verification: {
          mode: 'deterministic',
          minimumScore: 1,
          requirements: ['Submission must report twelve passing tests and zero failures.'],
          deterministicChecks: [
            {
              id: 'passed-tests',
              kind: 'json_path_equals',
              description: 'All twelve expected tests passed.',
              path: ['tests', 'passed'],
              expected: 12,
              weightBps: 7000,
              hardFailure: true,
            },
            {
              id: 'failed-tests',
              kind: 'json_path_equals',
              description: 'No tests failed.',
              path: ['tests', 'failed'],
              expected: 0,
              weightBps: 3000,
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
        providerAgentId: 'erc8004:16602:456',
        providerAddress,
      },
    });
    const assignmentReplay = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/assign`,
      headers: { authorization, 'idempotency-key': assignmentKey },
      payload: {
        providerAgentId: 'erc8004:16602:456',
        providerAddress,
      },
    });

    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().data.job).toMatchObject({
      state: 'ASSIGNED',
      providerAgentId: 'erc8004:16602:456',
    });
    expect(assigned.json().data.assignment).toMatchObject({
      status: 'CONFIRMED',
      providerAgentId: 'erc8004:16602:456',
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
        patch: 'diff --git a/src/sorter.ts b/src/sorter.ts',
        tests: { passed: 12, failed: 0 },
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
      providerAgentId: 'erc8004:16602:456',
      storageRootHash: `0x${'d'.repeat(64)}`,
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
    expect(verified.statusCode).toBe(200);
    expect(verified.json().data.job.state).toBe('PASSED');
    expect(verified.json().data.verification).toMatchObject({
      outcome: 'PASS',
      scoreBps: 10_000,
      reportStorageRootHash: `0x${'f'.repeat(64)}`,
    });
    expect(verificationReplay.headers['idempotency-replayed']).toBe('true');
    expect(verifications.json().data.verifications).toHaveLength(1);
    expect(evidenceStorage.calls).toBe(2);

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
    `);
    expect(persisted.rows[0]).toEqual({
      state: 'PASSED',
      events: '9',
      submissions: '1',
      artifacts: '1',
      payload: null,
      verificationRuns: '1',
      verificationChecks: '2',
      verificationReports: '1',
      reportPayload: null,
    });
  });
});

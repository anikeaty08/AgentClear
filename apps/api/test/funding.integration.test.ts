import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { ViemJobEscrowGateway } from '@agentclear/chain';
import {
  createDatabaseClient,
  PostgresEscrowRepository,
  PostgresJobRepository,
} from '@agentclear/db';
import { FundingService, JobService } from '@agentclear/domain';
import { sql } from 'drizzle-orm';
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Abi,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { BootstrapApiKeyAuthenticator } from '../src/auth.js';

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

describe.skipIf(databaseUrl === undefined)('AgentClear funding API with PostgreSQL and Anvil', () => {
  const database = createDatabaseClient(databaseUrl!);
  const apiKey = 'funding-integration-api-key-at-least-32-chars';
  let anvil: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let publicClient: ReturnType<typeof createPublicClient>;

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
    const [deployer] = await unlockedWallet.getAddresses();
    if (deployer === undefined) throw new Error('Anvil did not expose a deployer account.');

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
    const gateway = new ViemJobEscrowGateway({ rpcUrl, chain, contractAddress, account: signer });
    app = await buildApp({
      jobRepository,
      jobService: new JobService({ repository: jobRepository }),
      fundingService: new FundingService({
        jobRepository,
        escrowRepository: new PostgresEscrowRepository(database.db),
        gateway,
        maxPerJobBaseUnits: parseEther('1').toString(),
      }),
      chainHealth: async () => gateway.health(),
      authenticator: new BootstrapApiKeyAuthenticator(
        apiKey,
        'funding-integration-pepper-at-least-32-chars',
        'operator_funding_it',
      ),
    });
  });

  beforeEach(async () => {
    await database.db.execute(
      sql`truncate table escrow_funding_operations, escrows, idempotency_records, job_state_events, job_requirements, jobs`,
    );
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await database.close();
    if (anvil !== undefined && anvil.exitCode === null) anvil.kill();
  });

  it('creates, quotes, and funds one job with an attested transaction-backed state change', async () => {
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
          requirements: ['All supplied tests pass'],
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
    const persisted = await database.db.execute<{ state: string; events: string }>(sql`
      select
        (select state::text from jobs where id = ${jobId}) as state,
        (select count(*)::text from job_state_events where job_id = ${jobId}) as events
    `);
    expect(persisted.rows[0]).toEqual({ state: 'FUNDED', events: '3' });
  });
});

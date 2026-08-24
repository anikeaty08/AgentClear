import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  SandboxExecutionFailedError,
  canonicalJson,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxVerifier,
} from '@agentclear/domain';
import { z } from 'zod';

const digestPinnedImageSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/:+-]*@sha256:[0-9a-f]{64}$/);

const runnerOutputSchema = z
  .object({
    version: z.literal('1'),
    testCount: z.number().int().min(0).max(100),
    passedTests: z.number().int().min(0).max(100),
    failedTests: z.number().int().min(0).max(100),
    failures: z.array(z.string().min(1).max(100)).max(100),
    logs: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            stdout: z.string(),
            stderr: z.string(),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.passedTests + value.failedTests !== value.testCount) {
      context.addIssue({ code: 'custom', message: 'Sandbox result counts do not balance.' });
    }
    if (value.failures.length !== value.failedTests || value.logs.length !== value.testCount) {
      context.addIssue({ code: 'custom', message: 'Sandbox result evidence is incomplete.' });
    }
    const logIds = value.logs.map(({ id }) => id);
    if (new Set(logIds).size !== logIds.length || new Set(value.failures).size !== value.failures.length) {
      context.addIssue({ code: 'custom', message: 'Sandbox result contains duplicate test IDs.' });
    }
    if (value.failures.some((id) => !logIds.includes(id))) {
      context.addIssue({ code: 'custom', message: 'Sandbox failure evidence is inconsistent.' });
    }
  });

const containerStateSchema = z
  .object({
    ExitCode: z.number().int(),
    OOMKilled: z.boolean(),
    Running: z.boolean(),
  })
  .passthrough();

const HARNESS_FILE = '.agentclear-runner.mjs';
const CASE_RUNNER_FILE = '.agentclear-case-runner.mjs';
const CONFIG_FILE = '.agentclear-tests.json';
const CONTAINER_WORKSPACE = '/workspace';

const RUNNER_SOURCE = `import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const config = JSON.parse(await readFile(new URL('./${CONFIG_FILE}', import.meta.url), 'utf8'));
const caseRunnerUrl = new URL('./${CASE_RUNNER_FILE}', import.meta.url);
const maxCaseOutputBytes = Math.max(64, Math.floor(32768 / Math.max(1, config.testVectors.length * 2)));

function runCase(test) {
  return new Promise((resolve) => {
    const child = fork(caseRunnerUrl, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let nonce = null;
    let actual;
    let receivedResult = false;
    let settled = false;
    let truncated = false;
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const append = (target, chunk) => {
      const remaining = maxCaseOutputBytes - outputBytes;
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        target.push(accepted);
        outputBytes += accepted.byteLength;
      }
      if (chunk.byteLength > remaining) {
        truncated = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', (chunk) => append(stdout, chunk));
    child.stderr.on('data', (chunk) => append(stderr, chunk));
    child.on('message', (message) => {
      if (typeof message !== 'object' || message === null) return;
      if (message.phase === 'ready' && nonce === null && typeof message.nonce === 'string') {
        nonce = message.nonce;
        child.send({
          entryFile: config.entryFile,
          exportName: config.exportName,
          input: test.input,
        });
        return;
      }
      if (message.phase === 'result' && message.nonce === nonce) {
        actual = message.actual;
        receivedResult = true;
      }
    });
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({
        passed: exitCode === 0 && receivedResult && !truncated && isDeepStrictEqual(actual, test.expected),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
      });
    };
    child.once('error', () => finish(null));
    child.once('close', finish);
  });
}

const failures = [];
const logs = [];
let passedTests = 0;
for (const test of config.testVectors) {
  const result = await runCase(test);
  logs.push({ id: test.id, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated });
  if (result.passed) {
    passedTests += 1;
  } else {
    failures.push(test.id);
  }
}
const result = {
  version: '1',
  testCount: config.testVectors.length,
  passedTests,
  failedTests: failures.length,
  failures,
  logs,
};
process.stdout.write(JSON.stringify(result));
if (failures.length > 0) process.exitCode = 1;
`;

const CASE_RUNNER_SOURCE = `import { randomBytes } from 'node:crypto';

const send = process.send?.bind(process);
const exit = process.exit.bind(process);
const isArray = Array.isArray;
const hasOwn = Object.hasOwn;
const getPrototypeOf = Object.getPrototypeOf;
const objectKeys = Object.keys;
const isFiniteNumber = Number.isFinite;
const stringify = JSON.stringify.bind(JSON);
const parse = JSON.parse.bind(JSON);
const weakHas = WeakSet.prototype.has;
const weakAdd = WeakSet.prototype.add;
const weakDelete = WeakSet.prototype.delete;
const objectPrototype = Object.prototype;

function isJsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return isFiniteNumber(value);
  if (typeof value !== 'object') return false;
  if (weakHas.call(seen, value)) return false;
  weakAdd.call(seen, value);
  try {
    if (isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!hasOwn(value, index) || !isJsonValue(value[index], seen)) return false;
      }
      return objectKeys(value).length === value.length;
    }
    const prototype = getPrototypeOf(value);
    if (prototype !== objectPrototype && prototype !== null) return false;
    for (const key of objectKeys(value)) {
      if (!isJsonValue(value[key], seen)) return false;
    }
    return true;
  } finally {
    weakDelete.call(seen, value);
  }
}

if (send === undefined) exit(1);
const nonce = randomBytes(32).toString('hex');
send({ phase: 'ready', nonce });
process.once('message', async (request) => {
  try {
    if (typeof request !== 'object' || request === null) throw new TypeError('Invalid request.');
    const moduleUrl = new URL('./' + request.entryFile, import.meta.url);
    const submittedModule = await import(moduleUrl.href);
    const target = request.exportName === 'default'
      ? submittedModule.default
      : submittedModule[request.exportName];
    if (typeof target !== 'function') throw new TypeError('The agreed export is not a function.');
    const actual = await target(request.input);
    if (!isJsonValue(actual)) throw new TypeError('The result is not JSON data.');
    const canonicalActual = parse(stringify(actual));
    send({ phase: 'result', nonce, actual: canonicalActual }, () => exit(0));
  } catch {
    exit(1);
  }
});
`;

export type CommandRunOptions = {
  timeoutMs: number;
  maxOutputBytes: number;
};

export type CommandRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
};

export interface ContainerCommandRunner {
  run(arguments_: readonly string[], options: CommandRunOptions): Promise<CommandRunResult>;
}

export class SpawnContainerCommandRunner implements ContainerCommandRunner {
  public constructor(
    private readonly command = 'docker',
    private readonly prefixArguments: readonly string[] = [],
  ) {
    if (command.trim().length === 0) throw new TypeError('Container CLI command is required.');
  }

  public async run(
    arguments_: readonly string[],
    options: CommandRunOptions,
  ): Promise<CommandRunResult> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.prefixArguments, ...arguments_], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let timedOut = false;
      let outputTruncated = false;
      let settled = false;

      const stop = (): void => {
        if (!child.killed) child.kill('SIGKILL');
      };
      const append = (target: Buffer[], chunk: Buffer): void => {
        const remaining = options.maxOutputBytes - outputBytes;
        if (remaining > 0) {
          const accepted = chunk.subarray(0, remaining);
          target.push(accepted);
          outputBytes += accepted.byteLength;
        }
        if (chunk.byteLength > remaining) {
          outputTruncated = true;
          stop();
        }
      };

      child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
      timeout.unref();

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          outputTruncated,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}

export type DockerSandboxOptions = {
  image: string;
  runner?: ContainerCommandRunner;
  mapWorkspacePath?: (workspacePath: string) => Promise<string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxFileBytes?: number;
  maxTotalFileBytes?: number;
  memoryMb?: number;
  cpuLimit?: string;
  processLimit?: number;
  temporaryFilesystemMb?: number;
  idGenerator?: () => string;
};

export type SandboxHealth = {
  ready: boolean;
  image: string;
};

export class DockerSandboxVerifier implements SandboxVerifier {
  readonly #image: string;
  readonly #runner: ContainerCommandRunner;
  readonly #mapWorkspacePath: (workspacePath: string) => Promise<string>;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #maxFileBytes: number;
  readonly #maxTotalFileBytes: number;
  readonly #memoryMb: number;
  readonly #cpuLimit: string;
  readonly #processLimit: number;
  readonly #temporaryFilesystemMb: number;
  readonly #idGenerator: () => string;

  public constructor(options: DockerSandboxOptions) {
    this.#image = digestPinnedImageSchema.parse(options.image);
    this.#runner = options.runner ?? new SpawnContainerCommandRunner();
    this.#mapWorkspacePath = options.mapWorkspacePath ?? (async (path) => path);
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, 'Sandbox timeout');
    this.#maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 65_536, 'Sandbox output limit');
    this.#maxFileBytes = positiveInteger(options.maxFileBytes ?? 65_536, 'Sandbox file limit');
    this.#maxTotalFileBytes = positiveInteger(
      options.maxTotalFileBytes ?? 262_144,
      'Sandbox total file limit',
    );
    this.#memoryMb = positiveInteger(options.memoryMb ?? 128, 'Sandbox memory limit');
    this.#cpuLimit = z.string().regex(/^(?:0\.[1-9]|[1-9]\d*(?:\.\d+)?)$/).parse(options.cpuLimit ?? '0.5');
    this.#processLimit = positiveInteger(options.processLimit ?? 32, 'Sandbox process limit');
    this.#temporaryFilesystemMb = positiveInteger(
      options.temporaryFilesystemMb ?? 16,
      'Sandbox temporary filesystem limit',
    );
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  public async health(): Promise<SandboxHealth> {
    try {
      const result = await this.#runner.run(['image', 'inspect', this.#image], {
        timeoutMs: 15_000,
        maxOutputBytes: 65_536,
      });
      return { ready: result.exitCode === 0 && !result.timedOut, image: this.#image };
    } catch {
      return { ready: false, image: this.#image };
    }
  }

  public async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    if (request.runtime !== 'node24') throw new SandboxExecutionFailedError();
    const artifactHash = this.#validateAndHashFiles(request.files);
    const workspace = await mkdtemp(join(tmpdir(), 'agentclear-sandbox-'));
    const containerName = `agentclear-${this.#idGenerator().replaceAll('-', '').slice(0, 24)}`;
    let creationAttempted = false;
    let created = false;
    let result: SandboxExecutionResult | undefined;
    let primaryError: unknown;

    try {
      await this.#writeWorkspace(workspace, request);
      const mappedWorkspace = await this.#mapWorkspacePath(workspace);
      if (mappedWorkspace.includes(',') || /[\r\n]/u.test(mappedWorkspace)) {
        throw new SandboxExecutionFailedError();
      }
      creationAttempted = true;
      const createResult = await this.#runner.run(
        this.#createArguments(containerName, mappedWorkspace),
        { timeoutMs: 30_000, maxOutputBytes: 65_536 },
      );
      if (createResult.exitCode !== 0 || createResult.timedOut || createResult.outputTruncated) {
        throw new SandboxExecutionFailedError();
      }
      created = true;
      const startedAt = Date.now();
      const attached = await this.#runner.run(['start', '--attach', containerName], {
        timeoutMs: this.#timeoutMs,
        maxOutputBytes: this.#maxOutputBytes,
      });
      if (attached.timedOut || attached.outputTruncated) {
        result = {
          exitCode: null,
          stdoutSummary: attached.stdout,
          stderrSummary: attached.stderr,
          durationMs: Date.now() - startedAt,
          testCount: request.testVectors.length,
          passedTests: 0,
          failedTests: request.testVectors.length,
          timedOut: attached.timedOut,
          outputTruncated: attached.outputTruncated,
          outOfMemory: false,
          artifactHash,
        };
      } else {
        result = await this.#readCompletedResult(
          containerName,
          attached,
          request.testVectors.length,
          artifactHash,
          Date.now() - startedAt,
        );
      }
    } catch (error) {
      primaryError = error;
    } finally {
      let cleanupFailed = false;
      if (creationAttempted) {
        try {
          const cleanup = await this.#runner.run(['rm', '--force', containerName], {
            timeoutMs: 15_000,
            maxOutputBytes: 65_536,
          });
          cleanupFailed = created && (cleanup.exitCode !== 0 || cleanup.timedOut);
        } catch {
          cleanupFailed = created;
        }
      }
      await rm(workspace, { recursive: true, force: true });
      if (cleanupFailed) primaryError = new SandboxExecutionFailedError();
    }

    if (primaryError !== undefined) {
      if (primaryError instanceof SandboxExecutionFailedError) throw primaryError;
      throw new SandboxExecutionFailedError();
    }
    if (result === undefined) throw new SandboxExecutionFailedError();
    return result;
  }

  #validateAndHashFiles(files: Readonly<Record<string, string>>): `0x${string}` {
    const entries = Object.entries(files);
    if (entries.length === 0 || entries.length > 32) throw new SandboxExecutionFailedError();
    let totalBytes = 0;
    for (const [name, source] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.mjs$/u.test(name)) {
        throw new SandboxExecutionFailedError();
      }
      const bytes = Buffer.byteLength(source, 'utf8');
      if (bytes > this.#maxFileBytes) throw new SandboxExecutionFailedError();
      totalBytes += bytes;
    }
    if (totalBytes > this.#maxTotalFileBytes) throw new SandboxExecutionFailedError();
    const digest = createHash('sha256').update(canonicalJson({ files })).digest('hex');
    return `0x${digest}`;
  }

  async #writeWorkspace(workspace: string, request: SandboxExecutionRequest): Promise<void> {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    for (const [name, source] of Object.entries(request.files)) {
      await writeFile(join(workspace, name), source, { encoding: 'utf8', mode: 0o444, flag: 'wx' });
    }
    await writeFile(
      join(workspace, CONFIG_FILE),
      canonicalJson({
        entryFile: request.entryFile,
        exportName: request.exportName,
        testVectors: request.testVectors,
      }),
      { encoding: 'utf8', mode: 0o444, flag: 'wx' },
    );
    await writeFile(join(workspace, HARNESS_FILE), RUNNER_SOURCE, {
      encoding: 'utf8',
      mode: 0o444,
      flag: 'wx',
    });
    await writeFile(join(workspace, CASE_RUNNER_FILE), CASE_RUNNER_SOURCE, {
      encoding: 'utf8',
      mode: 0o444,
      flag: 'wx',
    });
  }

  #createArguments(containerName: string, workspace: string): string[] {
    return [
      'create',
      '--name', containerName,
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--user', '65532:65532',
      '--memory', `${this.#memoryMb}m`,
      '--memory-swap', `${this.#memoryMb}m`,
      '--cpus', this.#cpuLimit,
      '--pids-limit', String(this.#processLimit),
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${this.#temporaryFilesystemMb}m,uid=65532,gid=65532`,
      '--mount', `type=bind,source=${workspace},target=${CONTAINER_WORKSPACE},readonly`,
      '--workdir', CONTAINER_WORKSPACE,
      this.#image,
      'node',
      '--disable-proto=throw',
      '--no-addons',
      HARNESS_FILE,
    ];
  }

  async #readCompletedResult(
    containerName: string,
    attached: CommandRunResult,
    expectedTestCount: number,
    artifactHash: `0x${string}`,
    durationMs: number,
  ): Promise<SandboxExecutionResult> {
    const inspected = await this.#runner.run(
      ['inspect', '--format', '{{json .State}}', containerName],
      { timeoutMs: 15_000, maxOutputBytes: 65_536 },
    );
    if (inspected.exitCode !== 0 || inspected.timedOut || inspected.outputTruncated) {
      throw new SandboxExecutionFailedError();
    }
    let state: z.infer<typeof containerStateSchema>;
    try {
      state = containerStateSchema.parse(JSON.parse(inspected.stdout.trim()));
    } catch {
      throw new SandboxExecutionFailedError();
    }
    if (state.Running) throw new SandboxExecutionFailedError();
    const parsedOutput = runnerOutputSchema.safeParse(safeJsonParse(attached.stdout));
    const counts = parsedOutput.success && parsedOutput.data.testCount === expectedTestCount
      ? parsedOutput.data
      : {
          testCount: expectedTestCount,
          passedTests: 0,
          failedTests: expectedTestCount,
        };
    return {
      exitCode: state.ExitCode,
      stdoutSummary: attached.stdout,
      stderrSummary: attached.stderr,
      durationMs,
      testCount: counts.testCount,
      passedTests: counts.passedTests,
      failedTests: counts.failedTests,
      timedOut: false,
      outputTruncated: false,
      outOfMemory: state.OOMKilled,
      artifactHash,
    };
  }
}

export function createWslDockerSandbox(options: Omit<DockerSandboxOptions, 'runner' | 'mapWorkspacePath'>): DockerSandboxVerifier {
  const wslRunner = new SpawnContainerCommandRunner('wsl.exe', ['docker']);
  const pathRunner = new SpawnContainerCommandRunner('wsl.exe');
  return new DockerSandboxVerifier({
    ...options,
    runner: wslRunner,
    mapWorkspacePath: async (workspacePath) => {
      const result = await pathRunner.run(['wslpath', '-a', windowsPathForWsl(workspacePath)], {
        timeoutMs: 15_000,
        maxOutputBytes: 4096,
      });
      if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
        throw new SandboxExecutionFailedError();
      }
      return result.stdout.trim();
    },
  });
}

export function windowsPathForWsl(path: string): string {
  return path.replaceAll('\\', '/');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

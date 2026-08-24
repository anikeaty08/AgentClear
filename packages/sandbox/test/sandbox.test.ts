import { describe, expect, it } from 'vitest';

import {
  DockerSandboxVerifier,
  windowsPathForWsl,
  type CommandRunResult,
  type ContainerCommandRunner,
} from '../src/index.js';

const IMAGE = `node@sha256:${'a'.repeat(64)}`;

class RecordingRunner implements ContainerCommandRunner {
  public readonly calls: string[][] = [];

  public constructor(private readonly startResult?: Partial<CommandRunResult>) {}

  public async run(arguments_: readonly string[]): Promise<CommandRunResult> {
    this.calls.push([...arguments_]);
    const base = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      outputTruncated: false,
      durationMs: 1,
    } satisfies CommandRunResult;
    if (arguments_[0] === 'start') {
      return {
        ...base,
        stdout: JSON.stringify({
          version: '1',
          testCount: 2,
          passedTests: 2,
          failedTests: 0,
          failures: [],
          logs: [
            { id: 'one', stdout: '', stderr: '', truncated: false },
            { id: 'two', stdout: '', stderr: '', truncated: false },
          ],
        }),
        ...this.startResult,
      };
    }
    if (arguments_[0] === 'inspect') {
      return { ...base, stdout: JSON.stringify({ ExitCode: 0, OOMKilled: false, Running: false }) };
    }
    return base;
  }
}

const request = {
  runtime: 'node24' as const,
  files: { 'solution.mjs': 'export function add({ a, b }) { return a + b; }' },
  entryFile: 'solution.mjs',
  exportName: 'add',
  testVectors: [
    { id: 'one', input: { a: 1, b: 2 }, expected: 3 },
    { id: 'two', input: { a: -1, b: 1 }, expected: 0 },
  ],
};

describe('DockerSandboxVerifier', () => {
  it('preserves Windows path separators across the WSL process boundary', () => {
    expect(windowsPathForWsl('C:\\Users\\operator\\Temp\\run')).toBe(
      'C:/Users/operator/Temp/run',
    );
  });

  it('requires a digest-pinned image instead of a mutable tag', () => {
    expect(() => new DockerSandboxVerifier({ image: 'node:24-alpine' })).toThrow();
  });

  it('creates a hardened disposable container and removes it after a passing run', async () => {
    const runner = new RecordingRunner();
    const sandbox = new DockerSandboxVerifier({
      image: IMAGE,
      runner,
      mapWorkspacePath: async () => '/safe/workspace',
      idGenerator: () => '0198d462-75c0-7000-8000-000000000001',
    });

    const result = await sandbox.execute(request);

    expect(result).toMatchObject({
      exitCode: 0,
      testCount: 2,
      passedTests: 2,
      failedTests: 0,
      timedOut: false,
      outputTruncated: false,
      outOfMemory: false,
    });
    expect(result.artifactHash).toMatch(/^0x[0-9a-f]{64}$/);
    const create = runner.calls[0]!;
    expect(create).toContain('none');
    expect(create).toContain('--read-only');
    expect(create).toContain('ALL');
    expect(create).toContain('no-new-privileges:true');
    expect(create).toContain('65532:65532');
    expect(create).toContain('128m');
    expect(create).toContain('0.5');
    expect(create.some((argument) => argument.includes('source=/safe/workspace'))).toBe(true);
    expect(create).toContain(IMAGE);
    expect(runner.calls.map((call) => call[0])).toEqual(['create', 'start', 'inspect', 'rm']);
    expect(runner.calls.at(-1)).toContain('--force');
  });

  it('reports a real execution timeout and still force-removes the container', async () => {
    const runner = new RecordingRunner({ exitCode: null, timedOut: true });
    const sandbox = new DockerSandboxVerifier({
      image: IMAGE,
      runner,
      mapWorkspacePath: async () => '/safe/workspace',
    });

    await expect(sandbox.execute(request)).resolves.toMatchObject({
      exitCode: null,
      timedOut: true,
      failedTests: 2,
    });
    expect(runner.calls.map((call) => call[0])).toEqual(['create', 'start', 'rm']);
  });

  it('fails closed when the trusted runner returns inconsistent evidence counts', async () => {
    const runner = new RecordingRunner({
      stdout: JSON.stringify({
        version: '1',
        testCount: 2,
        passedTests: 2,
        failedTests: 0,
        failures: [],
        logs: [],
      }),
    });
    const sandbox = new DockerSandboxVerifier({
      image: IMAGE,
      runner,
      mapWorkspacePath: async () => '/safe/workspace',
    });

    await expect(sandbox.execute(request)).resolves.toMatchObject({
      passedTests: 0,
      failedTests: 2,
    });
  });

  it('attempts named cleanup even when container creation has an ambiguous timeout', async () => {
    const calls: string[][] = [];
    const runner: ContainerCommandRunner = {
      run: async (arguments_) => {
        calls.push([...arguments_]);
        return {
          exitCode: arguments_[0] === 'create' ? null : 1,
          stdout: '',
          stderr: '',
          timedOut: arguments_[0] === 'create',
          outputTruncated: false,
          durationMs: 1,
        };
      },
    };
    const sandbox = new DockerSandboxVerifier({
      image: IMAGE,
      runner,
      mapWorkspacePath: async () => '/safe/workspace',
    });

    await expect(sandbox.execute(request)).rejects.toMatchObject({
      code: 'SANDBOX_EXECUTION_FAILED',
    });
    expect(calls.map((call) => call[0])).toEqual(['create', 'rm']);
    expect(calls[1]).toContain('--force');
  });

  it('rejects oversized provider code before starting a container', async () => {
    const runner = new RecordingRunner();
    const sandbox = new DockerSandboxVerifier({
      image: IMAGE,
      runner,
      maxFileBytes: 8,
    });

    await expect(sandbox.execute(request)).rejects.toMatchObject({
      code: 'SANDBOX_EXECUTION_FAILED',
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('reports whether the pinned execution image is locally available', async () => {
    const runner = new RecordingRunner();
    const sandbox = new DockerSandboxVerifier({ image: IMAGE, runner });
    await expect(sandbox.health()).resolves.toEqual({ ready: true, image: IMAGE });
    expect(runner.calls[0]).toEqual(['image', 'inspect', IMAGE]);
  });
});

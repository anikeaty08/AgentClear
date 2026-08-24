import { describe, expect, it } from 'vitest';

import { DockerSandboxVerifier, createWslDockerSandbox } from '../src/index.js';

const image = process.env['SANDBOX_INTEGRATION_IMAGE'];
const describeLive = image === undefined ? describe.skip : describe;

describeLive('Docker sandbox integration', () => {
  const createSandbox = (timeoutMs = 5_000) =>
    process.env['SANDBOX_INTEGRATION_CLI'] === 'wsl-docker'
      ? createWslDockerSandbox({ image: image!, timeoutMs })
      : new DockerSandboxVerifier({ image: image!, timeoutMs });

  it('executes supplied code in a network-disabled disposable container', async () => {
    const sandbox = createSandbox();
    const result = await sandbox.execute({
      runtime: 'node24',
      files: {
        'solution.mjs': `import { networkInterfaces } from 'node:os';
export function verifyIsolation() {
  const interfaces = Object.keys(networkInterfaces());
  return interfaces.length > 0 && interfaces.every((name) => name === 'lo');
}`,
      },
      entryFile: 'solution.mjs',
      exportName: 'verifyIsolation',
      testVectors: [{ id: 'network-disabled', input: null, expected: true }],
    });

    expect(result).toMatchObject({
      exitCode: 0,
      testCount: 1,
      passedTests: 1,
      failedTests: 0,
      timedOut: false,
      outputTruncated: false,
      outOfMemory: false,
    });
  });

  it('terminates non-completing provider code at the actual container boundary', async () => {
    const sandbox = createSandbox(1_500);
    const result = await sandbox.execute({
      runtime: 'node24',
      files: { 'solution.mjs': 'export function neverReturns() { while (true) {} }' },
      entryFile: 'solution.mjs',
      exportName: 'neverReturns',
      testVectors: [{ id: 'timeout', input: null, expected: null }],
    });

    expect(result).toMatchObject({ timedOut: true, passedTests: 0, failedTests: 1 });
  });

  it('rejects a provider module that prints a forged success report and exits early', async () => {
    const sandbox = createSandbox();
    const forged = JSON.stringify({
      version: '1',
      testCount: 1,
      passedTests: 1,
      failedTests: 0,
      failures: [],
      logs: [],
    });
    const result = await sandbox.execute({
      runtime: 'node24',
      files: {
        'solution.mjs': `process.stdout.write(${JSON.stringify(forged)});
process.exit(0);
export function answer() { return 42; }`,
      },
      entryFile: 'solution.mjs',
      exportName: 'answer',
      testVectors: [{ id: 'forgery', input: null, expected: 42 }],
    });

    expect(result).toMatchObject({
      exitCode: 1,
      testCount: 1,
      passedTests: 0,
      failedTests: 1,
      timedOut: false,
    });
  });

  it('rejects provider results that cannot be represented as canonical JSON', async () => {
    const sandbox = createSandbox();
    const result = await sandbox.execute({
      runtime: 'node24',
      files: { 'solution.mjs': 'export function invalid() { return 42n; }' },
      entryFile: 'solution.mjs',
      exportName: 'invalid',
      testVectors: [{ id: 'json-only', input: null, expected: 42 }],
    });

    expect(result).toMatchObject({
      exitCode: 1,
      testCount: 1,
      passedTests: 0,
      failedTests: 1,
      timedOut: false,
    });
  });
});

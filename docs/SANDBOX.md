# Untrusted-code sandbox

## Boundary

`packages/sandbox` is the production adapter for deterministic executable checks. Provider code is written only to a fresh temporary workspace and is never imported, evaluated, or spawned by the API host. `VerificationService` depends on the `SandboxVerifier` domain port, so REST, future MCP, and workers share one policy and report format.

An agreement opts in with a `sandbox_tests` check containing:

- runtime `node24`;
- a flat `.mjs` entry filename and named/default export;
- one to 100 explicit JSON input/expected-output vectors;
- the same integer weight and hard-failure policy as other deterministic checks.

The provider submits `{ "files": { "solution.mjs": "..." } }`. Filenames reject directories/path traversal. File count, per-file bytes, total bytes, test count, output bytes, and report bytes are all bounded before or during execution.

## Container controls

Every check creates a uniquely named disposable container with:

- `--network none`;
- a read-only root filesystem and read-only `/workspace` bind mount;
- UID/GID `65532:65532`;
- every Linux capability dropped and `no-new-privileges` enabled;
- fixed memory with swap disabled, CPU quota, PID limit, and execution timeout;
- a bounded `noexec,nosuid,nodev` tmpfs;
- bounded combined stdout/stderr;
- no environment secrets, production credentials, host socket, or writable host mount;
- forced container removal and temporary-workspace cleanup on success, failure, timeout, or truncation.

The image must be configured by immutable digest. Mutable tags such as `node:24-alpine` are rejected. `/ready` fails when a configured image is not present locally. Production uses the direct `docker` CLI and must run on a dedicated sandbox worker/host with tightly controlled Docker-daemon access. The `wsl-docker` bridge exists only for local Windows development and is rejected in production configuration.

Docker-daemon access is a privileged operational boundary even when child containers are hardened. Do not co-locate this worker with wallets or other secrets in a production deployment. Image vulnerability scanning, rootless Docker/user namespaces, seccomp/AppArmor policy hardening, and a separate sandbox worker are release requirements before accepting arbitrary public workloads.

## Local verification

On 2026-08-24, the official `node:24-alpine` multi-platform index resolved through Docker Buildx to:

```text
node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
```

Node 24 is used because it is an officially supported LTS line; Node 20 reached end-of-life on 2026-03-24 according to the [official Node.js release schedule](https://nodejs.org/en/about/previous-releases). Resolve and review a current digest rather than assuming this one is still the desired release. Then run the opt-in real-container suite:

```powershell
$env:SANDBOX_INTEGRATION_IMAGE='node@sha256:<64-hex-digest>'
$env:SANDBOX_INTEGRATION_CLI='wsl-docker' # omit for direct Docker
pnpm --filter @agentclear/sandbox test:integration
```

The suite runs actual submitted modules. It proves that the container sees loopback networking only, that non-terminating provider code is killed by the real timeout boundary, and that module top-level code cannot forge a passing harness report by printing JSON and exiting early. Each vector runs in a child process and only a nonce-authenticated IPC response is scored by the trusted parent harness. Unit tests separately inspect every Docker hardening flag and forced-cleanup path.

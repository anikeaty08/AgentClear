import { AgentClearApiClient } from './backend.js';
import { createMcpHttpServer } from './http.js';
import { loadMcpRuntimeConfig } from '@agentclear/config';

const config = loadMcpRuntimeConfig();
const server = createMcpHttpServer({
  backendFactory: (apiKey) =>
    new AgentClearApiClient({
      baseUrl: config.apiBaseUrl,
      apiKey,
      timeoutMs: config.upstreamTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
    }),
  allowedHosts: config.allowedHosts,
  allowedOrigins: config.allowedOrigins,
  maxBodyBytes: config.maxBodyBytes,
  rateLimitPerMinute: config.rateLimitPerMinute,
});

const shutdown = (signal: NodeJS.Signals): void => {
  process.stdout.write(`${JSON.stringify({ level: 'info', signal, message: 'Stopping MCP server.' })}\n`);
  server.close((error) => {
    if (error !== undefined) {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', message: 'MCP shutdown failed.' })}\n`,
      );
      process.exitCode = 1;
    }
  });
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      message: 'AgentClear MCP server listening.',
      host: config.host,
      port: config.port,
      transport: 'streamable-http-stateless',
    })}\n`,
  );
});

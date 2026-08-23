import { randomUUID } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import type { JobRepository, JobService } from '@agentclear/domain';
import { DomainError } from '@agentclear/domain';
import Fastify, { LogController, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { ZodError, z } from 'zod';

import { ApiError } from './api-error.js';
import type { Authenticator, AuthPrincipal, AuthScope } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthPrincipal | null;
  }
}

const idempotencyKeySchema = z.string().min(8).max(255).regex(/^[A-Za-z0-9._:-]+$/);
const jobIdParamsSchema = z.object({ id: z.uuid() }).strict();

function readBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (authorization === undefined) {
    return null;
  }

  const [scheme, token, extra] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || extra !== undefined) {
    return null;
  }
  return token;
}

function requireScope(request: FastifyRequest, scope: AuthScope): AuthPrincipal {
  if (request.auth === null) {
    throw new ApiError('AUTHENTICATION_REQUIRED', 'A valid API key is required.', 401);
  }
  if (!request.auth.scopes.has(scope)) {
    throw new ApiError('INSUFFICIENT_SCOPE', `The ${scope} scope is required.`, 403);
  }
  return request.auth;
}

export type BuildAppOptions = {
  jobService: JobService;
  jobRepository: JobRepository;
  authenticator: Authenticator;
  logger?: FastifyServerOptions['logger'];
};

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
  });

  app.decorateRequest('auth', null);

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (request) => ({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Retry after the rate-limit window.',
        requestId: request.id,
      },
    }),
  });

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/v1/')) {
      return;
    }

    const apiKey = readBearerToken(request);
    request.auth = apiKey === null ? null : await options.authenticator.authenticate(apiKey);
    if (request.auth === null) {
      throw new ApiError('AUTHENTICATION_REQUIRED', 'A valid API key is required.', 401);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'The request did not match the expected schema.',
          requestId: request.id,
        },
      });
      return;
    }

    if (error instanceof DomainError || error instanceof ApiError) {
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
        },
      });
      return;
    }

    request.log.error({ err: error, requestId: request.id }, 'Unhandled API error');
    void reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        requestId: request.id,
      },
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    try {
      await options.jobRepository.ping();
      return { status: 'ready', dependencies: { database: 'up' } };
    } catch (error) {
      app.log.error({ err: error }, 'Readiness dependency failed');
      return reply.status(503).send({ status: 'not_ready', dependencies: { database: 'down' } });
    }
  });

  app.post('/v1/jobs', async (request, reply) => {
    const principal = requireScope(request, 'jobs:write');
    const idempotencyKey = idempotencyKeySchema.parse(request.headers['idempotency-key']);
    const result = await options.jobService.createJob(request.body, {
      actor: { type: principal.kind === 'agent' ? 'agent' : 'operator', id: principal.id },
      idempotencyKey,
    });

    return reply
      .status(201)
      .header('idempotency-replayed', result.replayed ? 'true' : 'false')
      .send({
        data: { job: result.job },
        meta: { requestId: request.id, replayed: result.replayed },
      });
  });

  app.get('/v1/jobs/:id', async (request) => {
    requireScope(request, 'jobs:read');
    const { id } = jobIdParamsSchema.parse(request.params);
    const job = await options.jobService.getJob(id);
    return { data: { job }, meta: { requestId: request.id } };
  });

  return app;
}

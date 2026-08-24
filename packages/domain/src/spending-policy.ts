import { z } from 'zod';

import { AUTH_PRINCIPAL_KINDS, type AuthPrincipal, type AuthPrincipalKind } from './api-key.js';
import { DELIVERABLE_TYPES, type DeliverableType } from './job.js';
import {
  ApiKeyPermissionDeniedError,
  SpendingApprovalRequiredError,
  SpendingAuthorizationConflictError,
  SpendingPolicyExceededError,
  SpendingPolicyNotConfiguredError,
} from './errors.js';

const principalIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const positiveBaseUnitsSchema = z.string().regex(/^[1-9]\d{0,77}$/);
const nonnegativeBaseUnitsSchema = z.string().regex(/^(?:0|[1-9]\d{0,77})$/);

export const putSpendingPolicyInputSchema = z
  .object({
    principalKind: z.enum(AUTH_PRINCIPAL_KINDS),
    maxPerJobBaseUnits: positiveBaseUnitsSchema,
    maxPerDayBaseUnits: positiveBaseUnitsSchema,
    maxPerMonthBaseUnits: positiveBaseUnitsSchema,
    allowedCapabilities: z
      .array(z.enum(DELIVERABLE_TYPES))
      .min(1)
      .max(DELIVERABLE_TYPES.length)
      .refine(
        (capabilities) => new Set(capabilities).size === capabilities.length,
        'Capabilities must be unique.',
      ),
    requireHumanApprovalAboveBaseUnits: nonnegativeBaseUnitsSchema.nullable().default(null),
  })
  .strict()
  .superRefine((input, context) => {
    const perJob = BigInt(input.maxPerJobBaseUnits);
    const perDay = BigInt(input.maxPerDayBaseUnits);
    const perMonth = BigInt(input.maxPerMonthBaseUnits);
    if (perJob > perDay || perDay > perMonth) {
      context.addIssue({
        code: 'custom',
        path: ['maxPerDayBaseUnits'],
        message: 'Spending limits must satisfy per-job <= per-day <= per-month.',
      });
    }
    if (
      input.requireHumanApprovalAboveBaseUnits !== null
      && BigInt(input.requireHumanApprovalAboveBaseUnits) > perJob
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requireHumanApprovalAboveBaseUnits'],
        message: 'The approval threshold cannot exceed the per-job maximum.',
      });
    }
  });

export type SpendingPolicy = {
  principalId: string;
  principalKind: AuthPrincipalKind;
  maxPerJobBaseUnits: string;
  maxPerDayBaseUnits: string;
  maxPerMonthBaseUnits: string;
  allowedCapabilities: DeliverableType[];
  requireHumanApprovalAboveBaseUnits: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type FundingAuthorizationStatus = 'PENDING_APPROVAL' | 'AUTHORIZED' | 'EXPIRED';

export type FundingAuthorization = {
  jobId: string;
  principalId: string;
  amountBaseUnits: string;
  capability: DeliverableType;
  status: FundingAuthorizationStatus;
  reservedAt: string;
  approvalExpiresAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
};

export type FundingAuthorizationDecision =
  | { outcome: 'AUTHORIZED'; authorization: FundingAuthorization }
  | { outcome: 'APPROVAL_REQUIRED'; authorization: FundingAuthorization }
  | { outcome: 'POLICY_NOT_FOUND' }
  | { outcome: 'LIMIT_EXCEEDED' }
  | { outcome: 'CONFLICT' };

export type AuthorizeFundingInput = {
  jobId: string;
  principalId: string;
  amountBaseUnits: string;
  capability: DeliverableType;
  requestedAt: string;
  approvalExpiresAt: string;
};

export interface SpendingAuthorizer {
  authorizeFunding(input: AuthorizeFundingInput): Promise<FundingAuthorizationDecision>;
}

export interface SpendingPolicyRepository extends SpendingAuthorizer {
  upsertPolicy(policy: SpendingPolicy): Promise<SpendingPolicy>;
  findPolicy(principalId: string): Promise<SpendingPolicy | null>;
  approveFunding(
    jobId: string,
    approvedBy: string,
    approvedAt: string,
  ): Promise<FundingAuthorizationDecision>;
}

export type SpendingPolicyServiceDependencies = {
  repository: SpendingPolicyRepository;
  clock?: () => Date;
};

export class SpendingPolicyService {
  readonly #repository: SpendingPolicyRepository;
  readonly #clock: () => Date;

  public constructor(dependencies: SpendingPolicyServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  public async putPolicy(
    principalIdValue: string,
    rawInput: unknown,
    actor: AuthPrincipal,
  ): Promise<SpendingPolicy> {
    this.#requireOperator(actor);
    const principalId = principalIdSchema.parse(principalIdValue);
    const input = putSpendingPolicyInputSchema.parse(rawInput);
    if (input.principalKind === 'agent' && !/^erc8004:\d+:\d+$/u.test(principalId)) {
      z.string().regex(/^erc8004:\d+:\d+$/).parse(principalId);
    }
    const now = this.#clock().toISOString();
    const existing = await this.#repository.findPolicy(principalId);
    if (existing !== null && existing.principalKind !== input.principalKind) {
      throw new SpendingAuthorizationConflictError();
    }
    return this.#repository.upsertPolicy({
      principalId,
      principalKind: input.principalKind,
      maxPerJobBaseUnits: input.maxPerJobBaseUnits,
      maxPerDayBaseUnits: input.maxPerDayBaseUnits,
      maxPerMonthBaseUnits: input.maxPerMonthBaseUnits,
      allowedCapabilities: [...input.allowedCapabilities],
      requireHumanApprovalAboveBaseUnits: input.requireHumanApprovalAboveBaseUnits,
      createdBy: existing?.createdBy ?? actor.id,
      updatedBy: actor.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  public async getPolicy(principalIdValue: string, actor: AuthPrincipal): Promise<SpendingPolicy | null> {
    this.#requireOperator(actor);
    return this.#repository.findPolicy(principalIdSchema.parse(principalIdValue));
  }

  public async approveFunding(
    jobId: string,
    actor: AuthPrincipal,
  ): Promise<FundingAuthorization> {
    this.#requireOperator(actor);
    const decision = await this.#repository.approveFunding(
      jobId,
      actor.id,
      this.#clock().toISOString(),
    );
    switch (decision.outcome) {
      case 'AUTHORIZED':
        return decision.authorization;
      case 'POLICY_NOT_FOUND':
        throw new SpendingPolicyNotConfiguredError();
      case 'LIMIT_EXCEEDED':
        throw new SpendingPolicyExceededError();
      case 'CONFLICT':
        throw new SpendingAuthorizationConflictError();
      case 'APPROVAL_REQUIRED':
        throw new SpendingApprovalRequiredError();
    }
  }

  #requireOperator(actor: AuthPrincipal): void {
    if (actor.kind !== 'operator' || !actor.scopes.has('spending-policies:manage')) {
      throw new ApiKeyPermissionDeniedError();
    }
  }
}

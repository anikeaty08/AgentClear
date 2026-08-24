import type {
  AuthorizeFundingInput,
  FundingAuthorization,
  FundingAuthorizationDecision,
  SpendingPolicy,
  SpendingPolicyRepository,
} from '@agentclear/domain';
import { eq, sql } from 'drizzle-orm';

import type { AgentClearDatabase } from './client.js';
import { fundingAuthorizations, spendingPolicies } from './schema.js';

function rowToPolicy(row: typeof spendingPolicies.$inferSelect): SpendingPolicy {
  return {
    principalId: row.principalId,
    principalKind: row.principalKind,
    maxPerJobBaseUnits: row.maxPerJobBaseUnits,
    maxPerDayBaseUnits: row.maxPerDayBaseUnits,
    maxPerMonthBaseUnits: row.maxPerMonthBaseUnits,
    allowedCapabilities: row.allowedCapabilities,
    requireHumanApprovalAboveBaseUnits: row.requireHumanApprovalAboveBaseUnits,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToAuthorization(
  row: typeof fundingAuthorizations.$inferSelect,
): FundingAuthorization {
  return {
    jobId: row.jobId,
    principalId: row.principalId,
    amountBaseUnits: row.amountBaseUnits,
    capability: row.capability,
    status: row.status,
    reservedAt: row.reservedAt.toISOString(),
    approvalExpiresAt: row.approvalExpiresAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
  };
}

export class PostgresSpendingPolicyRepository implements SpendingPolicyRepository {
  public constructor(private readonly database: AgentClearDatabase) {}

  public async upsertPolicy(policy: SpendingPolicy): Promise<SpendingPolicy> {
    const [row] = await this.database
      .insert(spendingPolicies)
      .values({
        principalId: policy.principalId,
        principalKind: policy.principalKind,
        maxPerJobBaseUnits: policy.maxPerJobBaseUnits,
        maxPerDayBaseUnits: policy.maxPerDayBaseUnits,
        maxPerMonthBaseUnits: policy.maxPerMonthBaseUnits,
        allowedCapabilities: policy.allowedCapabilities,
        requireHumanApprovalAboveBaseUnits: policy.requireHumanApprovalAboveBaseUnits,
        createdBy: policy.createdBy,
        updatedBy: policy.updatedBy,
        createdAt: new Date(policy.createdAt),
        updatedAt: new Date(policy.updatedAt),
      })
      .onConflictDoUpdate({
        target: spendingPolicies.principalId,
        set: {
          principalKind: policy.principalKind,
          maxPerJobBaseUnits: policy.maxPerJobBaseUnits,
          maxPerDayBaseUnits: policy.maxPerDayBaseUnits,
          maxPerMonthBaseUnits: policy.maxPerMonthBaseUnits,
          allowedCapabilities: policy.allowedCapabilities,
          requireHumanApprovalAboveBaseUnits: policy.requireHumanApprovalAboveBaseUnits,
          updatedBy: policy.updatedBy,
          updatedAt: new Date(policy.updatedAt),
        },
      })
      .returning();
    if (row === undefined) throw new Error('Spending policy upsert returned no row.');
    return rowToPolicy(row);
  }

  public async findPolicy(principalId: string): Promise<SpendingPolicy | null> {
    const [row] = await this.database
      .select()
      .from(spendingPolicies)
      .where(eq(spendingPolicies.principalId, principalId))
      .limit(1);
    return row === undefined ? null : rowToPolicy(row);
  }

  public async authorizeFunding(
    input: AuthorizeFundingInput,
  ): Promise<FundingAuthorizationDecision> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agentclear:spending:${input.principalId}`}))`,
      );
      const requestedAt = new Date(input.requestedAt);
      const approvalExpiresAt = new Date(input.approvalExpiresAt);
      const [existing] = await transaction
        .select()
        .from(fundingAuthorizations)
        .where(eq(fundingAuthorizations.jobId, input.jobId))
        .for('update')
        .limit(1);
      if (existing !== undefined) {
        if (
          existing.principalId !== input.principalId
          || existing.amountBaseUnits !== input.amountBaseUnits
          || existing.capability !== input.capability
        ) {
          return { outcome: 'CONFLICT' };
        }
        if (existing.status === 'AUTHORIZED') {
          return { outcome: 'AUTHORIZED', authorization: rowToAuthorization(existing) };
        }
        if (
          existing.status === 'PENDING_APPROVAL'
          && existing.approvalExpiresAt !== null
          && existing.approvalExpiresAt.getTime() > requestedAt.getTime()
        ) {
          return { outcome: 'APPROVAL_REQUIRED', authorization: rowToAuthorization(existing) };
        }
        if (existing.status === 'PENDING_APPROVAL') {
          await transaction
            .update(fundingAuthorizations)
            .set({ status: 'EXPIRED' })
            .where(eq(fundingAuthorizations.jobId, input.jobId));
        }
      }

      const [policy] = await transaction
        .select()
        .from(spendingPolicies)
        .where(eq(spendingPolicies.principalId, input.principalId))
        .for('update')
        .limit(1);
      if (policy === undefined) return { outcome: 'POLICY_NOT_FOUND' };
      if (
        !policy.allowedCapabilities.includes(input.capability)
        || BigInt(input.amountBaseUnits) > BigInt(policy.maxPerJobBaseUnits)
      ) {
        return { outcome: 'LIMIT_EXCEEDED' };
      }

      const totals = await activeTotals(transaction, input.principalId, requestedAt);
      const amount = BigInt(input.amountBaseUnits);
      if (
        totals.day + amount > BigInt(policy.maxPerDayBaseUnits)
        || totals.month + amount > BigInt(policy.maxPerMonthBaseUnits)
      ) {
        return { outcome: 'LIMIT_EXCEEDED' };
      }
      const needsApproval = policy.requireHumanApprovalAboveBaseUnits !== null
        && amount > BigInt(policy.requireHumanApprovalAboveBaseUnits);
      const values = {
        principalId: input.principalId,
        amountBaseUnits: input.amountBaseUnits,
        capability: input.capability,
        status: needsApproval ? 'PENDING_APPROVAL' as const : 'AUTHORIZED' as const,
        reservedAt: requestedAt,
        approvalExpiresAt: needsApproval ? approvalExpiresAt : null,
        approvedBy: null,
        approvedAt: null,
      };
      const [authorization] = existing === undefined
        ? await transaction
            .insert(fundingAuthorizations)
            .values({ jobId: input.jobId, ...values })
            .returning()
        : await transaction
            .update(fundingAuthorizations)
            .set(values)
            .where(eq(fundingAuthorizations.jobId, input.jobId))
            .returning();
      if (authorization === undefined) throw new Error('Funding authorization returned no row.');
      return needsApproval
        ? { outcome: 'APPROVAL_REQUIRED', authorization: rowToAuthorization(authorization) }
        : { outcome: 'AUTHORIZED', authorization: rowToAuthorization(authorization) };
    });
  }

  public async approveFunding(
    jobId: string,
    approvedBy: string,
    approvedAtValue: string,
  ): Promise<FundingAuthorizationDecision> {
    const [candidate] = await this.database
      .select({ principalId: fundingAuthorizations.principalId })
      .from(fundingAuthorizations)
      .where(eq(fundingAuthorizations.jobId, jobId))
      .limit(1);
    if (candidate === undefined) return { outcome: 'CONFLICT' };
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`agentclear:spending:${candidate.principalId}`}))`,
      );
      const approvedAt = new Date(approvedAtValue);
      const [authorization] = await transaction
        .select()
        .from(fundingAuthorizations)
        .where(eq(fundingAuthorizations.jobId, jobId))
        .for('update')
        .limit(1);
      if (authorization === undefined || authorization.principalId !== candidate.principalId) {
        return { outcome: 'CONFLICT' };
      }
      if (authorization.status === 'AUTHORIZED') {
        return { outcome: 'AUTHORIZED', authorization: rowToAuthorization(authorization) };
      }
      if (
        authorization.status !== 'PENDING_APPROVAL'
        || authorization.approvalExpiresAt === null
        || authorization.approvalExpiresAt.getTime() <= approvedAt.getTime()
      ) {
        if (authorization.status === 'PENDING_APPROVAL') {
          await transaction
            .update(fundingAuthorizations)
            .set({ status: 'EXPIRED' })
            .where(eq(fundingAuthorizations.jobId, jobId));
        }
        return { outcome: 'CONFLICT' };
      }
      const [policy] = await transaction
        .select()
        .from(spendingPolicies)
        .where(eq(spendingPolicies.principalId, authorization.principalId))
        .for('update')
        .limit(1);
      if (policy === undefined) return { outcome: 'POLICY_NOT_FOUND' };
      const totals = await activeTotals(transaction, authorization.principalId, approvedAt, jobId);
      const amount = BigInt(authorization.amountBaseUnits);
      if (
        !policy.allowedCapabilities.includes(authorization.capability)
        || amount > BigInt(policy.maxPerJobBaseUnits)
        || totals.day + amount > BigInt(policy.maxPerDayBaseUnits)
        || totals.month + amount > BigInt(policy.maxPerMonthBaseUnits)
      ) {
        return { outcome: 'LIMIT_EXCEEDED' };
      }
      const [approved] = await transaction
        .update(fundingAuthorizations)
        .set({
          status: 'AUTHORIZED',
          reservedAt: approvedAt,
          approvalExpiresAt: null,
          approvedBy,
          approvedAt,
        })
        .where(eq(fundingAuthorizations.jobId, jobId))
        .returning();
      if (approved === undefined) throw new Error('Funding approval returned no row.');
      return { outcome: 'AUTHORIZED', authorization: rowToAuthorization(approved) };
    });
  }
}

async function activeTotals(
  database: Pick<AgentClearDatabase, 'execute'>,
  principalId: string,
  now: Date,
  excludeJobId?: string,
): Promise<{ day: bigint; month: bigint }> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const result = await database.execute<{ day_total: string; month_total: string }>(sql`
    select
      coalesce(sum(${fundingAuthorizations.amountBaseUnits}) filter (
        where ${fundingAuthorizations.reservedAt} >= ${dayStart}
      ), 0)::text as day_total,
      coalesce(sum(${fundingAuthorizations.amountBaseUnits}), 0)::text as month_total
    from ${fundingAuthorizations}
    where ${fundingAuthorizations.principalId} = ${principalId}
      and ${fundingAuthorizations.reservedAt} >= ${monthStart}
      ${excludeJobId === undefined ? sql`` : sql`and ${fundingAuthorizations.jobId} <> ${excludeJobId}`}
      and (
        ${fundingAuthorizations.status} = 'AUTHORIZED'
        or (
          ${fundingAuthorizations.status} = 'PENDING_APPROVAL'
          and ${fundingAuthorizations.approvalExpiresAt} > ${now}
        )
      )
  `);
  return {
    day: BigInt(result.rows[0]?.day_total ?? '0'),
    month: BigInt(result.rows[0]?.month_total ?? '0'),
  };
}

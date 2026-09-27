import { describe, expect, it } from 'vitest';
import {
  buildPaperRelayEvidence,
  type BuildPaperRelayEvidenceInput,
} from '../lib/paperRelayEvidence';

const NOW = 1_777_000_000_000;

function safeStoredState(
  overrides: Partial<BuildPaperRelayEvidenceInput> = {},
): BuildPaperRelayEvidenceInput {
  return {
    nowMs: NOW,
    dbOk: true,
    blockingIntentCount: 0,
    openRelayTaskCount: 0,
    unresolvedTaskCount: 0,
    activeRevokeInProgress: false,
    prepareStageCounts: {},
    blockingProtectionCount: 0,
    uncoveredStopCount: 0,
    legacyZeroFeeCount: 0,
    unsettledLiveTradeCount: 0,
    protectionReconciliation: {
      lastRunAtMs: NOW - 1_000,
      complete: true,
      blockNewOpens: false,
      ambiguousCount: 0,
    },
    ...overrides,
  };
}

describe('PAPER canonical authorization/action-budget observation contract', () => {
  it('publishes independent exact fail-closed execution-only entries', () => {
    const evidence = buildPaperRelayEvidence(safeStoredState());
    const canonical = evidence.executionOnly.filter(
      (entry) => entry.id === 'canonicalAuthorization',
    );
    const budget = evidence.executionOnly.filter(
      (entry) => entry.id === 'actionBudget',
    );

    expect(canonical).toEqual([{
      id: 'canonicalAuthorization',
      status: 'not_evaluated',
      fresh: false,
      observedAtMs: null,
      ageMs: null,
      failureId: 'CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER',
    }]);
    expect(budget).toEqual([{
      id: 'actionBudget',
      status: 'not_evaluated',
      fresh: false,
      observedAtMs: null,
      ageMs: null,
      failureId: 'ACTION_BUDGET_NOT_EVALUATED_IN_PAPER',
    }]);
    expect(evidence.executionAuthorized).toBe(false);
    expect(canonical[0]).not.toBe(budget[0]);
    expect(evidence.failureIds).not.toContain(
      'CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER',
    );
    expect(evidence.failureIds).not.toContain(
      'ACTION_BUDGET_NOT_EVALUATED_IN_PAPER',
    );
    expect(evidence.safe).toBe(true);
  });

  it('does not reinterpret canonical on-chain remaining=0 as PAPER evaluation', () => {
    const canonicalOnchainSnapshot = {
      isSubaccountListed: false,
      authorized: false,
      remaining: 0,
    };
    const evidence = buildPaperRelayEvidence(safeStoredState());
    const canonical = evidence.executionOnly.find(
      (entry) => entry.id === 'canonicalAuthorization',
    );
    const budget = evidence.executionOnly.find(
      (entry) => entry.id === 'actionBudget',
    );

    expect(canonicalOnchainSnapshot).toEqual({
      isSubaccountListed: false,
      authorized: false,
      remaining: 0,
    });
    expect(canonical).toMatchObject({
      status: 'not_evaluated',
      fresh: false,
      observedAtMs: null,
      ageMs: null,
    });
    expect(budget).toMatchObject({
      status: 'not_evaluated',
      fresh: false,
      observedAtMs: null,
      ageMs: null,
    });
    expect(budget).not.toHaveProperty('remaining');
    expect(evidence.executionAuthorized).toBe(false);
  });

  it('keeps execution-only entries exact while stored blocker reads fail closed', () => {
    const evidence = buildPaperRelayEvidence(safeStoredState({
      dbOk: false,
      blockingIntentCount: null,
      openRelayTaskCount: null,
      unresolvedTaskCount: null,
      activeRevokeInProgress: null,
      prepareStageCounts: null,
      blockingProtectionCount: null,
      uncoveredStopCount: null,
      legacyZeroFeeCount: null,
      unsettledLiveTradeCount: null,
      protectionReconciliation: {
        lastRunAtMs: null,
        complete: false,
        blockNewOpens: false,
        ambiguousCount: 0,
      },
    }));

    expect(evidence.safe).toBe(false);
    expect(evidence.executionAuthorized).toBe(false);
    expect(evidence.executionOnly).toEqual(expect.arrayContaining([
      {
        id: 'canonicalAuthorization',
        status: 'not_evaluated',
        fresh: false,
        observedAtMs: null,
        ageMs: null,
        failureId: 'CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER',
      },
      {
        id: 'actionBudget',
        status: 'not_evaluated',
        fresh: false,
        observedAtMs: null,
        ageMs: null,
        failureId: 'ACTION_BUDGET_NOT_EVALUATED_IN_PAPER',
      },
    ]));
    expect(evidence.failureIds).toContain('PAPER_RELAY_STATUS_DB_READ_FAILED');
    expect(evidence.failureIds).not.toContain(
      'CANONICAL_AUTHORIZATION_NOT_EVALUATED_IN_PAPER',
    );
    expect(evidence.failureIds).not.toContain(
      'ACTION_BUDGET_NOT_EVALUATED_IN_PAPER',
    );
  });
});
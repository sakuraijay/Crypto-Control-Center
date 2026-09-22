import type { VirtualPaper400SessionV1 } from './virtualPaper400Ledger';

/** One explicit user-authorized PAPER credit. Never a refill, new-account bonus or profit. */
export const AUTHORIZED_PAPER_CREDIT = Object.freeze({
  id: 'user-approved-paper-credit-20260922-100',
  sessionId: 'vp400-8fca5a3d-e988-4c98-b4a3-f9953ff54289',
  amountUsd: 100,
  eligibleAfter: '2026-09-22T06:34:00.000Z',
});
export interface PaperContribution {
  id: string; sessionId: string; amountUsd: number; appliedAt: string;
  purpose: 'USER_AUTHORIZED_PAPER_CONTRIBUTION';
}
export function validatePaperContributions(raw: unknown, session: VirtualPaper400SessionV1): PaperContribution[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 1) throw Error('PAPER_CONTRIBUTIONS_INVALID');
  for (const c of raw) {
    if (!c || Object.keys(c).sort().join(',') !== 'amountUsd,appliedAt,id,purpose,sessionId'
      || c.id !== AUTHORIZED_PAPER_CREDIT.id || c.sessionId !== session.sessionId
      || c.sessionId !== AUTHORIZED_PAPER_CREDIT.sessionId || c.amountUsd !== 100
      || c.purpose !== 'USER_AUTHORIZED_PAPER_CONTRIBUTION'
      || typeof c.appliedAt !== 'string' || !Number.isFinite(Date.parse(c.appliedAt))
      || new Date(c.appliedAt).toISOString() !== c.appliedAt
      || Date.parse(c.appliedAt) < Math.max(session.startedAtMs, Date.parse(AUTHORIZED_PAPER_CREDIT.eligibleAfter))) {
      throw Error('PAPER_CONTRIBUTIONS_INVALID');
    }
  }
  return raw;
}
export function applyAuthorizedPaperCredit<T extends { equityHwmUsd: number; contributions?: PaperContribution[] }>(
  state: T, session: VirtualPaper400SessionV1, now: Date, engineMode: string, active: boolean,
): T {
  const existing = validatePaperContributions(state.contributions, session);
  if (existing.length || engineMode !== 'PAPER' || !active || session.sessionId !== AUTHORIZED_PAPER_CREDIT.sessionId
    || now.getTime() < Date.parse(AUTHORIZED_PAPER_CREDIT.eligibleAfter)) return state;
  // Shift the high-water mark by the external cash flow; never erase historical losses/locks.
  return { ...state, equityHwmUsd: state.equityHwmUsd + 100, contributions: [{
    id: AUTHORIZED_PAPER_CREDIT.id, sessionId: session.sessionId, amountUsd: 100,
    appliedAt: now.toISOString(), purpose: 'USER_AUTHORIZED_PAPER_CONTRIBUTION',
  }] };
}

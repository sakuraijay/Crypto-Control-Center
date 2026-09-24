import type { VirtualPaper400SessionV1 } from './virtualPaper400Ledger';

/** Explicit user-authorized PAPER credits. Never a refill, new-account bonus or profit. */
export const AUTHORIZED_PAPER_CREDIT = Object.freeze({
  id: 'user-approved-paper-credit-20260922-100',
  sessionId: 'vp400-8fca5a3d-e988-4c98-b4a3-f9953ff54289',
  amountUsd: 100,
  eligibleAfter: '2026-09-22T06:34:00.000Z',
});
export const AUTHORIZED_PAPER_SEED_1000_CREDIT = Object.freeze({
  id: 'user-approved-paper-credit-20260924-500',
  sessionId: AUTHORIZED_PAPER_CREDIT.sessionId,
  amountUsd: 500,
  eligibleAfter: '2026-09-24T06:20:00.000Z',
});
const AUTHORIZED_PAPER_CREDITS = [AUTHORIZED_PAPER_CREDIT, AUTHORIZED_PAPER_SEED_1000_CREDIT] as const;
export interface PaperContribution {
  id: string; sessionId: string; amountUsd: number; appliedAt: string;
  purpose: 'USER_AUTHORIZED_PAPER_CONTRIBUTION';
}
export function validatePaperContributions(raw: unknown, session: VirtualPaper400SessionV1): PaperContribution[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > AUTHORIZED_PAPER_CREDITS.length) throw Error('PAPER_CONTRIBUTIONS_INVALID');
  for (const [index, c] of raw.entries()) {
    const authorized = AUTHORIZED_PAPER_CREDITS[index];
    if (!c || Object.keys(c).sort().join(',') !== 'amountUsd,appliedAt,id,purpose,sessionId'
      || c.id !== authorized.id || c.sessionId !== session.sessionId
      || c.sessionId !== authorized.sessionId || c.amountUsd !== authorized.amountUsd
      || c.purpose !== 'USER_AUTHORIZED_PAPER_CONTRIBUTION'
      || typeof c.appliedAt !== 'string' || !Number.isFinite(Date.parse(c.appliedAt))
      || new Date(c.appliedAt).toISOString() !== c.appliedAt
      || Date.parse(c.appliedAt) < Math.max(session.startedAtMs, Date.parse(authorized.eligibleAfter),
        index > 0 ? Date.parse(raw[index - 1].appliedAt) : 0)) {
      throw Error('PAPER_CONTRIBUTIONS_INVALID');
    }
  }
  return raw;
}
export function applyAuthorizedPaperCredit<T extends { equityHwmUsd: number; contributions?: PaperContribution[] }>(
  state: T, session: VirtualPaper400SessionV1, now: Date, engineMode: string, active: boolean,
): T {
  const existing = validatePaperContributions(state.contributions, session);
  if (engineMode !== 'PAPER' || !active || session.sessionId !== AUTHORIZED_PAPER_CREDIT.sessionId
    || !Number.isFinite(now.getTime()) || now.getTime() < session.startedAtMs) return state;
  const pending = AUTHORIZED_PAPER_CREDITS.slice(existing.length)
    .filter(c => now.getTime() >= Date.parse(c.eligibleAfter));
  if (!pending.length) return state;
  if (existing.some(c => Date.parse(c.appliedAt) > now.getTime())) throw Error('PAPER_CONTRIBUTION_FUTURE');
  // Shift the high-water mark by the external cash flow; never erase historical losses/locks.
  return { ...state, equityHwmUsd: state.equityHwmUsd + pending.reduce((sum, c) => sum + c.amountUsd, 0),
    contributions: [...existing, ...pending.map(c => ({
      id: c.id, sessionId: session.sessionId, amountUsd: c.amountUsd,
      appliedAt: now.toISOString(), purpose: 'USER_AUTHORIZED_PAPER_CONTRIBUTION' as const,
    }))] };
}

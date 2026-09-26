import {
  WORKER_FIXED_BETA_CONTEXT,
  WORKER_STANDARD_ACTIVE_CONTEXT,
  type ValidWorkerCapitalPolicySelection,
} from './workerCapitalPolicy';

/** This row can only be written by the operator-authenticated API route. */
export const WORKER_POLICY_CONTEXT_KEY = 'worker_policy_context_v1';
export const WORKER_POLICY_CONTEXT_SCHEMA_VERSION = 1 as const;

/** Legacy strategy autosave is not an operator capability writer. Inspect the
 * entire JSON tree, including arrays/indicator params, before any DB mutation. */
export function containsReservedAccountingFields(value: unknown): boolean {
  const normalize = (text: string) => text.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const reservedKeys = new Set([
    'policycontext', 'capitalpolicycontext', 'workerpolicycontext', 'referencecontext',
    'referencecapital', 'referencecapitalusd', 'alphacontext', 'alphacapitalusd',
    'betacontext', 'betacapitalusd', 'betaexecutionauthorized', 'executionauthorized',
    'approvalcreationallowed', 'paperpositionmutationallowed', 'livepositionmutationallowed',
    'accountingstate', 'accountingnamespace', 'accountingpolicycontext', 'tradestrategy',
    'fixedbetaaccountingstate', 'fixedbetaaccountingstatev1', 'workerpolicycontextv1',
    'authoritativehistoricalhardstoppresent', 'ledgerbinding',
  ]);
  const reservedValues = new Set([
    'fixedbeta400', 'fixedbetareferencev1', 'fixedbetaaccountingstatev1',
    'workerpolicycontextv1', 'serverworkeraifixedbeta400v1',
  ]);
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && reservedValues.has(normalize(item))) return true;
    if (Array.isArray(item)) pending.push(...item);
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (reservedKeys.has(normalize(key)) || reservedValues.has(normalize(key))) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

export interface WorkerPolicyContextV1 {
  schemaVersion: typeof WORKER_POLICY_CONTEXT_SCHEMA_VERSION;
  policyContext: ValidWorkerCapitalPolicySelection['policyContext'];
  approvedBy: 'OPERATOR_AUTH_V1';
  approvedAt: string;
}

export function parseWorkerPolicyContextV1(raw: string | null | undefined):
  | { ok: true; context: WorkerPolicyContextV1 }
  | { ok: true; context: null }
  | { ok: false; reason: 'WORKER_POLICY_CONTEXT_INVALID' } {
  // Absence is the explicit legacy Standard path only.  It is never beta.
  if (raw === null || raw === undefined) return { ok: true, context: null };
  try {
    const value = JSON.parse(raw) as Partial<WorkerPolicyContextV1>;
    if (
      value.schemaVersion !== WORKER_POLICY_CONTEXT_SCHEMA_VERSION
      || (value.policyContext !== WORKER_STANDARD_ACTIVE_CONTEXT
        && value.policyContext !== WORKER_FIXED_BETA_CONTEXT)
      || value.approvedBy !== 'OPERATOR_AUTH_V1'
      || typeof value.approvedAt !== 'string'
      || !Number.isFinite(Date.parse(value.approvedAt))
    ) return { ok: false, reason: 'WORKER_POLICY_CONTEXT_INVALID' };
    return { ok: true, context: value as WorkerPolicyContextV1 };
  } catch {
    return { ok: false, reason: 'WORKER_POLICY_CONTEXT_INVALID' };
  }
}
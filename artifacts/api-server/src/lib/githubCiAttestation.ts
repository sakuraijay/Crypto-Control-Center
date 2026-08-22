/**
 * Public GitHub Actions attestation for the manually controlled Canary.
 *
 * The build embeds the exact reviewed PR-head SHA after proving that the local
 * security-critical source has no diff from that SHA. Runtime then performs a
 * bounded, credential-free read against GitHub's public Actions API and only
 * accepts the pinned workflow when it completed successfully for that SHA.
 *
 * No GitHub token is read or required. Unknown, timeout, rate-limit, malformed,
 * or mismatched responses all fail closed.
 */
import type { CheckOutcome } from './manualCanary';

declare const __CANARY_RELEASE_SHA__: string;

const REPOSITORY = 'sakuraijay/Crypto-Control-Center';
const HEAD_BRANCH = 'codex/handover-20260820';
const WORKFLOW_ID = 335563590;
const WORKFLOW_NAME = 'CI — TypeScript · Build · Tests';
const REQUEST_TIMEOUT_MS = 5_000;
const SUCCESS_CACHE_MS = 5 * 60_000;

interface WorkflowRun {
  id?: unknown;
  run_number?: unknown;
  workflow_id?: unknown;
  name?: unknown;
  event?: unknown;
  status?: unknown;
  conclusion?: unknown;
  head_branch?: unknown;
  head_sha?: unknown;
}

interface WorkflowRunsPayload {
  workflow_runs?: unknown;
}

interface AttestationDeps {
  releaseSha?: string | null;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  timeoutMs?: number;
}

interface CachedSuccess {
  sha: string;
  expiresAtMs: number;
  outcome: CheckOutcome;
}

let cachedSuccess: CachedSuccess | null = null;

function embeddedReleaseSha(): string | null {
  if (typeof __CANARY_RELEASE_SHA__ === 'undefined') return null;
  return /^[0-9a-f]{40}$/.test(__CANARY_RELEASE_SHA__) ? __CANARY_RELEASE_SHA__ : null;
}

export function findAttestedWorkflowRun(
  payload: WorkflowRunsPayload,
  releaseSha: string,
): WorkflowRun | null {
  if (!Array.isArray(payload.workflow_runs)) return null;
  return (payload.workflow_runs as WorkflowRun[]).find((run) =>
    run.workflow_id === WORKFLOW_ID
    && run.name === WORKFLOW_NAME
    && run.event === 'pull_request'
    && run.status === 'completed'
    && run.conclusion === 'success'
    && run.head_branch === HEAD_BRANCH
    && run.head_sha === releaseSha
    && typeof run.id === 'number'
    && typeof run.run_number === 'number'
  ) ?? null;
}

export async function checkGitHubCiAttestation(
  deps: AttestationDeps = {},
): Promise<CheckOutcome> {
  const releaseSha = deps.releaseSha ?? embeddedReleaseSha();
  if (!releaseSha || !/^[0-9a-f]{40}$/.test(releaseSha)) {
    return { ok: false, detail: 'CI 배포 SHA 미결속 [UNATTESTED]' };
  }

  const nowMs = deps.nowMs ?? Date.now();
  if (!deps.fetchImpl && cachedSuccess?.sha === releaseSha && cachedSuccess.expiresAtMs > nowMs) {
    return cachedSuccess.outcome;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('github-ci-timeout')), timeoutMs);
  try {
    const query = new URLSearchParams({
      event: 'pull_request',
      status: 'completed',
      head_sha: releaseSha,
      per_page: '10',
    });
    const response = await fetchImpl(
      `https://api.github.com/repos/${REPOSITORY}/actions/runs?${query.toString()}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'crypto-control-center-canary-attestation',
          'x-github-api-version': '2022-11-28',
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return { ok: false, detail: `CI 공개 검증 응답 ${response.status} [UNATTESTED]` };
    }

    const payload = await response.json() as WorkflowRunsPayload;
    const run = findAttestedWorkflowRun(payload, releaseSha);
    if (!run) return { ok: false, detail: '일치하는 성공 CI 실행 없음 [UNATTESTED]' };

    const outcome: CheckOutcome = {
      ok: true,
      detail: `CI run #${String(run.run_number)} 성공 · release ${releaseSha.slice(0, 7)} 결속`,
    };
    if (!deps.fetchImpl) {
      cachedSuccess = { sha: releaseSha, expiresAtMs: nowMs + SUCCESS_CACHE_MS, outcome };
    }
    return outcome;
  } catch {
    return { ok: false, detail: 'CI 공개 검증 실패/시간초과 [UNATTESTED]' };
  } finally {
    clearTimeout(timeout);
  }
}

export function __resetGitHubCiAttestationForTests(): void {
  cachedSuccess = null;
}


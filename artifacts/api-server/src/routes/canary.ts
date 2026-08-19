/**
 * #135 — Manual Controlled Canary 라우트 (운영자 인증 필수).
 *
 *  GET  /executor/canary/status     — 단계별 상태 (read-only)
 *  GET  /executor/canary/preflight  — 1단계: read-only 전 항목 점검 (?symbol=&direction=)
 *  POST /executor/canary/execute    — 2단계: preflightId+confirm 결속, 서버 전 조건 재평가 후 단일 OPEN
 *  POST /executor/canary/close      — stop ACTIVE 증거 후 일반 close / mode:"emergency"
 *
 * PIN·서명·암호문·개인키·RPC URL은 어떤 응답/로그에도 포함되지 않는다.
 * 오류는 sanitizeRpcError로 새니타이즈.
 */
import { Router, type IRouter } from 'express';
import { requireOperatorAuth } from '../lib/operatorAuthGuard';
import { sanitizeRpcError } from '../lib/rpcErrorSanitize';
import {
  runCanaryPreflight, executeManualCanaryOpen, executeManualCanaryClose,
  getCanaryStatus, MANUAL_CANARY_CAPS, type ManualCanaryDeps,
} from '../lib/manualCanary';
import { buildDefaultCanaryDeps } from '../lib/manualCanaryDeps';

const router: IRouter = Router();

let _depsOverride: ManualCanaryDeps | null = null;
/** 테스트 전용 — 의존성 주입 override */
export function __setCanaryDepsForTests(deps: ManualCanaryDeps | null): void { _depsOverride = deps; }
function deps(): ManualCanaryDeps { return _depsOverride ?? buildDefaultCanaryDeps(); }

router.get('/executor/canary/status', requireOperatorAuth, async (_req, res) => {
  try {
    const status = await getCanaryStatus(deps());
    return res.json({ ...status, ok: true });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

router.get('/executor/canary/preflight', requireOperatorAuth, async (req, res) => {
  try {
    const result = await runCanaryPreflight(deps(), req.query.symbol, req.query.direction);
    return res.json({ caps: MANUAL_CANARY_CAPS, ...result });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

router.post('/executor/canary/execute', requireOperatorAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await executeManualCanaryOpen(deps(), body);
    const status = result.phase === 'REJECTED' ? 409 : result.phase === 'ERROR' ? 502 : 200;
    return res.status(status).json({ ...result });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

router.post('/executor/canary/close', requireOperatorAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await executeManualCanaryClose(deps(), body);
    const status = result.phase === 'REJECTED' ? 409 : result.phase === 'ERROR' ? 502 : 200;
    return res.status(status).json({ ...result });
  } catch (e: unknown) {
    return res.status(500).json({ ok: false, error: sanitizeRpcError(e) });
  }
});

export default router;

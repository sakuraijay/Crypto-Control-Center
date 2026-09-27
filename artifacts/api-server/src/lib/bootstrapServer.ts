/**
 * #121 — 콜드스타트 부트스트랩 핸들러.
 *
 * 문제: 무거운 모듈 import(라우트·SDK·worker)가 끝나기 전에는 포트가 닫혀 있어
 * 플랫폼 프록시가 connection-refused를 HTTP 500으로 노출했다 (~30초 창).
 *
 * 해결: index.ts가 최소 의존성만 로드한 뒤 즉시 포트를 열고, 본체 앱이
 * 로드될 때까지 모든 요청에 명시적 503 JSON(fail-closed)을 반환한다.
 * 본체(Express app)가 준비되면 delegate로 위임되어 기존 라우팅 계약이
 * 그대로 적용된다 (readiness 게이트·/healthz 200 계약 불변).
 *
 * 순수 팩토리 — http/Express·DB·env에 의존하지 않아 격리 테스트 가능.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type Delegate = (req: IncomingMessage, res: ServerResponse) => void;

export interface BootstrapControl {
  handler: Delegate;
  /** 본체 앱 로드 완료 시 1회 호출 — 이후 모든 요청은 앱으로 위임된다. */
  setDelegate: (d: Delegate) => void;
  /** 현재 위임 상태 (테스트·진단용) */
  hasDelegate: () => boolean;
}

export function createBootstrapControl(): BootstrapControl {
  let delegate: Delegate | null = null;

  const handler: Delegate = (req, res) => {
    if (delegate) {
      delegate(req, res);
      return;
    }
    // 본체 미로드 — 명시적 503 JSON (500·HTML·connection refused 금지)
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Retry-After", "5");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ status: "starting", ready: false }));
  };

  return {
    handler,
    setDelegate: (d) => {
      delegate = d;
    },
    hasDelegate: () => delegate !== null,
  };
}

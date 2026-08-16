/**
 * operatorAuthGuard — 민감(mutating) 운영자 API 보호 미들웨어.
 *
 * 인증: OPERATOR_MASTER_PIN(환경변수/Secret)과 x-operator-pin 헤더의
 * timing-safe 비교. PIN 미설정 시 fail-closed(503) — 열어두지 않는다.
 *
 * CSRF 방어: 브라우저 폼/단순 요청은 커스텀 헤더를 설정할 수 없으므로
 * x-operator-pin 헤더 요구 자체가 CSRF를 차단한다. 추가로
 * content-type: application/json만 허용한다.
 *
 * 오류 응답에 PIN 값·비교 결과 세부 정보를 절대 포함하지 않는다.
 */

import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

const MIN_PIN_LENGTH = 6;

export function isOperatorPinConfigured(): boolean {
  const pin = process.env.OPERATOR_MASTER_PIN?.trim();
  return !!pin && pin.length >= MIN_PIN_LENGTH;
}

function pinMatches(provided: string): boolean {
  const expected = process.env.OPERATOR_MASTER_PIN?.trim() ?? '';
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireOperatorAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isOperatorPinConfigured()) {
    res.status(503).json({
      ok: false,
      error: 'OPERATOR_MASTER_PIN 미설정 — 운영자 인증이 구성될 때까지 이 API는 잠깁니다 (fail-closed)',
    });
    return;
  }
  const ct = req.headers['content-type'] ?? '';
  if (req.method !== 'GET' && !String(ct).includes('application/json')) {
    res.status(415).json({ ok: false, error: 'application/json 요청만 허용됩니다' });
    return;
  }
  const provided = req.headers['x-operator-pin'];
  if (typeof provided !== 'string' || !pinMatches(provided)) {
    res.status(401).json({ ok: false, error: '운영자 인증 실패' });
    return;
  }
  next();
}

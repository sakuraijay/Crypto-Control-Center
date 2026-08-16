/**
 * liveTestDisplay — 6E-2 §6: LIVE TEST MODE 표시 상태 단일화.
 *
 * authoritative 소스는 서버 /api/executor/status 의 liveTestMode 필드다.
 * 브라우저 localStorage(strategy limits)의 liveTestMode는 "요청값"일 뿐이며
 * 서버가 PAPER이거나 liveTestMode=false이면 토글은 반드시 OFF로 표시한다.
 * localStorage 값으로 서버 상태를 덮어쓰는 복원은 금지.
 */

export interface LiveTestDisplayInput {
  /** 서버 /api/executor/status 응답의 liveTestMode (미수신 = null) */
  serverLiveTestMode: boolean | null | undefined;
  /** 서버 상태를 한 번이라도 성공적으로 받았는지 */
  serverStatusKnown: boolean;
  /** 브라우저(strategy limits)에 저장된 요청값 */
  localLiveTestMode: boolean;
}

export interface LiveTestDisplay {
  /** 토글·배지에 표시할 실제 상태 — 서버 기준 */
  checked: boolean;
  /** 로컬 요청값이 서버에 아직 적용되지 않은 상태 (구형 설정 포함) */
  localPendingNotApplied: boolean;
  /** 서버 상태 미확인 시 토글 조작 차단 */
  toggleDisabled: boolean;
  hint: string | null;
}

export function deriveLiveTestDisplay(input: LiveTestDisplayInput): LiveTestDisplay {
  const serverOn = input.serverLiveTestMode === true;
  if (!input.serverStatusKnown) {
    return {
      checked: false,
      localPendingNotApplied: input.localLiveTestMode,
      toggleDisabled: true,
      hint: '서버 상태 미확인 — /api/executor/status 응답 전까지 OFF로 표시됩니다 (fail-closed).',
    };
  }
  return {
    checked: serverOn,
    localPendingNotApplied: input.localLiveTestMode && !serverOn,
    toggleDisabled: false,
    hint: input.localLiveTestMode && !serverOn
      ? '브라우저에 저장된 LIVE TEST 설정이 있으나 서버에는 적용되지 않았습니다 — 서버 상태(OFF)가 기준입니다.'
      : null,
  };
}

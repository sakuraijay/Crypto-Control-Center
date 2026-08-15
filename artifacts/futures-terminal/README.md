# Futures Terminal — Expo Mobile App

> ⚠️ **FROZEN — 개발 동결**
>
> 이 Expo 모바일 앱(`artifacts/futures-terminal`)은 **데스크탑 웹 우선 개발 방침에 따라 동결**되었습니다.
>
> - 신규 기능은 **`artifacts/futures-web`(데스크탑 웹)에만 추가**됩니다.
> - 이 앱의 기존 기능(AI 사이클 조회, LIVE 승인, 비상정지 등)은 그대로 유지됩니다.
> - 버그 수정은 필요한 경우에 한해 최소한으로만 반영됩니다.
>
> **운영자는 `artifacts/futures-web`을 주 인터페이스로 사용하세요.**

---

## 개요

GMX V2 / Arbitrum One 선물 트레이딩 컨트롤 센터의 Expo 모바일 컴패니언 앱.

- AI 5-State 엔진 실시간 상태 조회
- LIVE 거래 제안 승인 / 거절
- 일일 성과 KPI
- 비상정지 제어

## 실행

```bash
pnpm --filter @workspace/futures-terminal run dev
```

## 의존성 주의사항

- `expo-notifications` 버전: `~0.32.17` (expo@54 전용 — v57.x는 Metro ENOENT 충돌 유발)

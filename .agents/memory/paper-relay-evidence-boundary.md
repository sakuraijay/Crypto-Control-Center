---
name: PAPER Relay evidence boundary
description: PAPER status에서 실행 전용 상태와 durable read-only 안전 결함을 분리하는 원칙
---

PAPER Relay 진단에서 canonical authorization, action budget, prepare/protection/settlement reconciliation은 실행 전용이므로 항상 `NOT EVALUATED`이며 실행 권한을 만들지 않는다. 반면 status 조립에 참여하는 durable DB read는 “없음”과 “조회 실패”를 구분해야 하고, 실패 또는 실제 잔존 결함은 고정된 sanitized failure ID로 `safe:false`가 되어야 한다.

**Why:** 빈 배열이나 `null` fallback이 DB 실패를 정상 0건으로 위장하면 PAPER read-only 진단이 안전하다고 오판할 수 있다. cached reconciliation 상태도 현재 DB read 실패를 가려서는 안 된다.

**How to apply:** PAPER status에 DB-backed reader를 추가할 때는 null-preserving result API와 대응 failure ID를 함께 추가하고, payload·signature·RPC URL·canonical 잔여 action/만료값은 진단에 노출하지 않는다.
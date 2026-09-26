---
name: Owner Approval durable 복구
description: 재시작 뒤 저장된 Owner Approval을 READY로 복원할 때의 fail-closed 신뢰 경계
---

`OWNER_SIGNATURE_READY` 상태 문자열만으로 READY를 복원하지 않는다. 현재 owner, canonical signer, Arbitrum chain, canonical relay router와 nonce, 모든 approval message 필드, 재계산 digest, 암호문 복호화, EIP-712 owner recovery를 모두 검증해야 한다.

**Why:** 서명 제출 시점의 검증이 강해도 콜드스타트 조회가 DB status만 신뢰하면, 만료·손상·설정 변경 evidence가 정상 READY처럼 보일 수 있다. 반대로 모든 실패를 `OWNER_SIGNATURE_REQUIRED`로 축약하면 만료가 persistence loss처럼 보인다.

**How to apply:** Startup은 durable evidence를 read-only로 검증해 프로세스 로컬 신뢰를 만들고, 공개 status 조회는 복호화를 유발하지 않는다. 실제 submit은 동일하게 검증된 DB snapshot의 capability만 사용한다. 만료·불일치 evidence는 자동 삭제하지 않되 READY로 합성하지 않고 안전한 원인 코드를 노출한다.
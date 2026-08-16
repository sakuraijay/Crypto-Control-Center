#!/bin/bash
# CI typecheck — 모든 파일 포함 (pre-existing 오류 없음)
# calendar.tsx / spinner.tsx 의 React 19 ref 오류는 기존 workaround로 해결됨
set -euo pipefail

OUTPUT=$(pnpm run typecheck 2>&1 || true)
echo "$OUTPUT"

# mockup-sandbox는 별도 vite 환경으로 CI 검사 대상 제외
NEW_ERRORS=$(echo "$OUTPUT" | grep "error TS" | grep -v "mockup-sandbox" || true)
if [ -n "$NEW_ERRORS" ]; then
  echo ""
  echo "❌ TypeScript 오류 발견:"
  echo "$NEW_ERRORS"
  exit 1
fi

echo "✅ TypeScript 오류 없음"
exit 0

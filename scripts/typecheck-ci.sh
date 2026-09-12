#!/bin/bash
# CI typecheck — 모든 workspace 파일 포함, pnpm 종료 코드를 그대로 전달
set -euo pipefail

set +e
OUTPUT=$(pnpm run typecheck 2>&1)
STATUS=$?
set -e
echo "$OUTPUT"

if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "❌ TypeScript 검사 실패 (exit $STATUS)"
  exit "$STATUS"
fi

echo "✅ TypeScript 오류 없음"

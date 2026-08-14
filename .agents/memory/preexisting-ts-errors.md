---
name: Pre-existing TypeScript errors in shadcn components
description: calendar.tsx and spinner.tsx have React 19 ref type mismatches — do not fix, do not treat as regressions
---

`artifacts/futures-web/src/components/ui/calendar.tsx` and `spinner.tsx` produce TypeScript errors under React 19 due to a `VoidOrUndefinedOnly` type incompatibility between two copies of `@types/react` resolved in the pnpm lockfile. These errors existed before any current work.

**Why:** pnpm hoisting of `@types/react@19.x` can create two structurally identical but nominally distinct versions of internal React types, causing `Ref<T>` incompatibilities in shadcn-generated components.

**How to apply:** When running `tsc --noEmit`, filter out errors from `calendar.tsx` and `spinner.tsx` before checking results. Do not attempt to "fix" them — the fix is a pnpm deduplication, not a code change.

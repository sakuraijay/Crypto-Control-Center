# Final P0 SRE verification — PASS

Candidate: `/tmp/ccc-alpha-p0-20260918`; baseline/HEAD `2c15698ce11dbd27dd028122b4c0b9d305cec4d4`.

## Verdict

**PASS** for the requested narrow final-source goals.

## Exact isolated command

```sh
env -i PATH="$PATH" HOME="$HOME" CI=true NODE_ENV=test pnpm --filter @workspace/api-server exec vitest run src/__tests__/fixedBetaAccountingState.test.ts src/__tests__/aiWorker.test.ts src/__tests__/riskProfileApiContract.test.ts src/__tests__/dataGuards.http.test.ts src/__tests__/reservedAccountingGuards.test.ts src/__tests__/serverPaperExecutor.test.ts
```

Exit: **0**. Results: **6 files passed, 242 tests passed**:
- `serverPaperExecutor.test.ts`: 86
- `aiWorker.test.ts`: 100
- `fixedBetaAccountingState.test.ts`: 23
- `reservedAccountingGuards.test.ts`: 19
- `riskProfileApiContract.test.ts`: 5
- `dataGuards.http.test.ts`: 9

Full stdout/stderr and command status: `/tmp/ccc-p0-sre-final-logs/08-targeted-vitest.log`.

`paperEpochActivation.test.ts`: **NOT RUN**. Its import requires an unavailable `DATABASE_URL`; no credential was inherited, invented, or added. This leaves real-DB epoch persistence outside this verification.

## Exact-source findings

- Startup reconstruction now requires durable `fullJson` proof of `source=server_worker`, `accountingPolicyContext=STANDARD_ACTIVE`, genuine `operatingState=CASH`, no `entryVeto`, and an allowed durable direction. Parse failures and absent/untagged scope return unknown rather than reconstructing a close.
- Real reconciliation seam tests cover Beta-tagged Alpha CASH, untagged/global CASH, invalid/Beta/Standard current selectors, and Standard-tagged entry-only veto. None creates a new Standard pending-close request. A scope-proven Standard CASH does reconstruct under either current Standard or Beta selection.
- Every newly persisted worker decision overwrites untrusted input with the manager's selected accounting policy tag before atomic claim; both Standard and Beta tags are tested.
- Legacy durable pending-close recovery remains active independent of selector validity. Real management tests under an invalid selector execute the already-persisted Standard close and a stop-loss close, preserve Standard strategy provenance, and create no OPEN. The unchanged server executor suite also passes pending-close/restart, SL/TP, duplicate CLOSE/OPEN, REDUCE70 reservation/singleflight, transaction rollback, and startup fail-closed cases.
- Prior replay/counter/accounting tests were read and rerun: completed-candle durable claims prevent duplicate downstream dispatch; lifecycle generation checks prevent stale continuation; nonzero losses/counters and sticky hard stop round-trip; empty/partial/malformed Alpha evidence does not overwrite with zeros; immutable checkpoint freshness and full-ledger binding remain enforced.
- Selector middleware tests now execute the actual Express middleware stack in-process. With a public test-only PIN they prove missing and wrong PIN return 401 before writes; valid PIN persists exactly one Standard/Beta selector envelope; invalid context returns 400; the PIN is absent from persisted data. The unconfigured guard remains fail-closed.

## Final SHA-256

```text
3aa5a88d7b600d6ad51bdc1b84ebe31408cbe6b42c1618b4e3ef88655d2c9a03  artifacts/api-server/src/routes/data.ts
5b8744c265d807951808da9aaef887e6a460d9134920fa82034a75c836829ee5  artifacts/api-server/src/__tests__/aiWorker.test.ts
fcdc4d145f402586a8142496021ae4105ea3ede11b0077737ab991a148ec0145  artifacts/api-server/src/__tests__/dataGuards.http.test.ts
0d9b2607dc8eea0bda8f3d3551bc0aa33fe6d8a4499aae196fb140a70b830e5e  artifacts/api-server/src/__tests__/fixedBetaAccountingState.test.ts
0c71950ef89c4d4a9721041867450fa4c3bffd0d11ccf3737cd85e6aa217d573  artifacts/api-server/src/__tests__/reservedAccountingGuards.test.ts
8b0801da9f0d37fe29df58fcea87ec0d17d3344d40b8deb459e7fb19db86e14b  artifacts/api-server/src/__tests__/riskProfileApiContract.test.ts
089b70c2186a9962d81e7663ef5321b04069f0ae47865a27e53e72d89389c751  artifacts/api-server/src/workers/aiWorker.ts
6be5897c54b8e8ea939dfb12772c8ce2f3ddd505f07d460c19ece2d9a81605d0  artifacts/api-server/src/workers/fixedBetaAccountingState.ts
6babb5a94b887a88e4e4130d0c394326280e649b8165646abdcfdb929995911c  artifacts/api-server/src/workers/serverTypes.ts
dacc7c12a6774b5224471aef19c102dc2d32be62cbd27cbf5bb12ff34eddf499  artifacts/api-server/src/workers/workerPolicyContext.ts
```

Initial and final manifests match (`cmp` exit 0): `/tmp/ccc-p0-sre-final-initial-sha256.txt` and `/tmp/ccc-p0-sre-final-sha256-v2.txt`.

## Limits

Tests use mocked/in-process DB and restart seams, not a real process/database restart. No app/listener, workflow, production environment, DB/RPC, migration, browser, or actual trade was used. Runtime production bootstrap and `betaExecutionAuthorized` were not enabled.

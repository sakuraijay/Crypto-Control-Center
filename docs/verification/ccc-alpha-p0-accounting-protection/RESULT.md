# CCC-ALPHA-P0-ACCOUNTING-PROTECTION-20260918

## Result and scope

Code review and isolated final-source operational verification PASS for the two
requested accounting/protection repairs. This is not alpha readiness, live
execution authorization, deployment, or original R3 recovery.

Baseline: `2c15698ce11dbd27dd028122b4c0b9d305cec4d4`.
The preserved rejected R1 archive remains unchanged; it was review material,
not a patch applied to the app.

## Implemented behavior

- Standard and Fixed Beta accounting use distinct identities. Alpha requires
  an explicitly selected, authenticated domain and a strict pre-provisioned
  accounting record. It never initializes missing alpha losses/counters or
  infers a wallet balance from the 400-USDC reference.
- Complete immutable ledger binding includes row count, full canonical row
  digest, and open inventory. Missing historical losses/held positions,
  malformed records, missing or stale per-position marks, and stale checkpoint
  evidence fail closed. They do not overwrite stored state with synthetic zeros.
- Nonzero scoped counters/losses and sticky HARD_STOP state survive repeated
  cycles and mocked restart. Routine writes do not renew source freshness.
- Risk/cost/sizing OPEN vetoes do not become CASH. Genuine close/reduce/risk
  actions remain distinct. Standard PAPER SL/TP and durable pending-close
  management continue independently of selected/invalid accounting context.
- Startup reconstruction of a missing close intent requires a durably proven
  Standard server-worker CASH decision, not a latest global/Alpha/entry-veto
  decision. Existing durable pending-close/reduce records still recover.
- The new policy selector requires existing operator authentication. Generic
  client writers cannot forge/change/delete reserved alpha accounting rows.
  Legacy strategy autosave remains compatible while reserved domain/capability
  fields are rejected recursively.
- Alpha OPEN stays blocked at PAPER, approval, and autonomous LIVE dispatch.
  Existing execution locks and risk/cost requirements remain unchanged.

### Explicit behavior boundary

Untagged historical AI decisions are scope-unknown and cannot synthesize a new
Standard close-all intent at startup. This does not delete or disable already
persisted close intents, SL/TP, or explicit qualified Standard exits.

No alpha accounting record was provisioned or migrated. Missing valid protected
evidence still blocks entry. The new parser contract requires complete evidence;
this work does not grant a writer authority to initialize it.

## Actual role separation

Four distinct AI subagent contexts were used, not four human engineers:

1. Design: read-only minimal-scope analysis of actual canonical code.
2. Implementation: one writer for all product and test changes/corrections.
3. Reviewer: separate read-only review of actual diff and counterexamples;
   rejected intermediate candidates and accepted the final corrected scope.
4. SRE: separate credential-scrubbed test execution and source-hash checks;
   no product edits.

The specialized architect tool kind was unavailable. The design and review
roles used separate general subagent executions with read-only instructions.
No claim is made that a special architect service or human audit ran.

## Final verification

Independent SRE command:

```sh
env -i PATH="$PATH" HOME="$HOME" CI=true NODE_ENV=test pnpm --filter @workspace/api-server exec vitest run src/__tests__/fixedBetaAccountingState.test.ts src/__tests__/aiWorker.test.ts src/__tests__/riskProfileApiContract.test.ts src/__tests__/dataGuards.http.test.ts src/__tests__/reservedAccountingGuards.test.ts src/__tests__/serverPaperExecutor.test.ts
```

PASS: 6 suites, 242 tests, exit 0.

- serverPaperExecutor: 86
- aiWorker: 100
- fixedBetaAccountingState: 23
- reservedAccountingGuards: 19
- riskProfileApiContract: 5
- dataGuards.http: 9

API typecheck PASS on the final product source. A prior web typecheck passed;
no frontend source changed afterward. git diff --check PASS.

The final SRE initial/final SHA-256 manifests match. Tests exercised real
in-process reconciliation/management and actual selector middleware with mocked
database/executor boundaries and a public test-only credential. They did not
use operational credentials or actual orders.

Earlier checks exposed genuine defects and fixture/type errors, which were
corrected and rechecked. A dependency-less worktree initially could not start
tests/typecheck; read-only dependency symlinks to existing installed packages
resolved that without installation or app restart.

The extra paperEpochActivation suite could not collect without DATABASE_URL
and was NOT part of the passing final run. No credential was added to make it
pass. Real database/process/deployed lifecycle verification remains outside
this isolated evidence.

See SRE-RESULT.md, source-sha256.txt, targeted-vitest.log, and typecheck.log
for the preserved final evidence. No fresh CI or deployment result is implied.

## Operational and budget boundaries

No app/workflow startup or restart, publishing, LIVE/Relay activation,
signing/key generation, wallet permissions, orders, transfers, operational DB,
capital/loss baseline/HWM, Secrets/PIN, or payment setting changes occurred.
No merge, rebase, force push, or competing branch/PR is authorized.

Attributable accumulated cost, individual task costs, and remaining budget:
UNKNOWN. The original cumulative $50 was not reset and $75 was not treated as
an approved or provider-enforced limit. No further paid implementation batch
starts automatically after this result.

September 18 13:00 Asia/Manila alpha and October 1 beta remain goals, not a
guaranteed outcome of this code change.
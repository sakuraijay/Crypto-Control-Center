import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool, Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export type DatabasePoolClient = pg.PoolClient;

export * from "./schema";

// ── Migration runner ────────────────────────────────────────────────────────
// SQL is embedded directly in code so the bundle can run it without any
// file-system path resolution (the dist/ directory has no migrations/ sibling).
// Each statement uses IF NOT EXISTS so re-running on startup is always safe.

const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_gmx_trade_fields",
    sql: `
      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS gmx_market_address text,
        ADD COLUMN IF NOT EXISTS collateral_token    text DEFAULT 'USDC',
        ADD COLUMN IF NOT EXISTS size_in_usd         numeric(18,4);
    `,
  },
  {
    name: "0002_ai_full_json",
    sql: `ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS full_json text;`,
  },
  {
    name: "0003_live_approvals",
    sql: `
      CREATE TABLE IF NOT EXISTS live_approvals (
        id               text PRIMARY KEY,
        decision_json    text NOT NULL,
        status           text NOT NULL DEFAULT 'PENDING',
        created_at       timestamptz NOT NULL DEFAULT now(),
        expires_at       timestamptz NOT NULL,
        approved_at      timestamptz,
        rejected_at      timestamptz,
        rejection_reason text
      );
    `,
  },
  {
    name: "0004_live_approvals_execution_outcome",
    sql: `ALTER TABLE live_approvals ADD COLUMN IF NOT EXISTS execution_outcome text;`,
  },
  {
    name: "0005_live_approvals_retry",
    sql: `
      ALTER TABLE live_approvals
        ADD COLUMN IF NOT EXISTS retry_count    integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_error     text,
        ADD COLUMN IF NOT EXISTS last_retried_at timestamptz;
    `,
  },
  {
    name: "0006_trades_leverage",
    sql: `
      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS leverage      numeric(8,2),
        ADD COLUMN IF NOT EXISTS collateral_usd numeric(18,4);
    `,
  },
  {
    name: "0007_worker_state",
    sql: `
      CREATE TABLE IF NOT EXISTS worker_state (
        key        text PRIMARY KEY,
        value      text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    name: "0008_live_test_mode",
    sql: `
      ALTER TABLE ai_decisions
        ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false;
      ALTER TABLE live_approvals
        ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false;
    `,
  },
  {
    name: "0009_trades_test_mode",
    sql: `ALTER TABLE trades ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false;`,
  },
  {
    name: "0010_execution_intents",
    sql: `
      CREATE TABLE IF NOT EXISTS execution_intents (
        id             text PRIMARY KEY,
        decision_id    text NOT NULL,
        cycle_number   integer NOT NULL,
        symbol         text NOT NULL,
        order_type     text NOT NULL,
        is_long        boolean NOT NULL,
        size_usd       numeric(18,4) NOT NULL,
        collateral_usd numeric(18,4) NOT NULL,
        tx_hash        text,
        status         text NOT NULL,
        error          text,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS execution_intents_status_idx ON execution_intents (status);
    `,
  },
  {
    name: "0011_execution_intents_single_active",
    sql: `
      -- 전역 단일 활성 intent 강제: 차단 상태(PREPARED/SUBMITTED/UNRESOLVED)의
      -- intent는 동시에 1개만 존재 가능. check-then-insert 경합을 DB 제약으로 차단.
      CREATE UNIQUE INDEX IF NOT EXISTS execution_intents_single_active_idx
        ON execution_intents ((1))
        WHERE status IN ('PREPARED', 'SUBMITTED', 'UNRESOLVED');
    `,
  },
  {
    name: "0012_execution_intents_onchain_evidence",
    sql: `
      -- 온체인 판정 근거 컬럼: receipt·order key·판정 블록·사유를 영속 저장
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS order_key text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS order_created_block text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS receipt_status text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS resolution_tx_hash text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS resolution_block text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS resolution_reason text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
    `,
  },
  {
    name: "0013_execution_intents_emitter_address",
    sql: `
      -- OrderCreated receipt에서 실제 일치한 EventEmitter 주소를 영속 저장.
      -- GMX upgrade로 emitter 주소가 바뀌어도 기존 intent를 reconcile 가능하게 한다.
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS order_emitter_address text;
    `,
  },
  {
    name: "0014_subaccount_approval_sessions",
    sql: `
      -- GMX delegated trading 2단계 — owner approval 세션.
      -- encrypted_signature: SESSION_SECRET 기반 AES-256-GCM 암호문 (전문·암호문 비노출).
      -- uint256 정밀도 보존을 위해 숫자 필드는 text(십진 문자열).
      CREATE TABLE IF NOT EXISTS subaccount_approval_sessions (
        id                  text PRIMARY KEY,
        main_account        text NOT NULL,
        subaccount          text NOT NULL,
        chain_id            text NOT NULL,
        verifying_contract  text NOT NULL,
        action_type         text NOT NULL,
        should_add          boolean NOT NULL,
        expires_at          text NOT NULL,
        max_allowed_count   text NOT NULL,
        approval_nonce      text NOT NULL,
        des_chain_id        text NOT NULL,
        deadline            text NOT NULL,
        integration_id      text NOT NULL,
        typed_data_digest   text NOT NULL,
        encrypted_signature text,
        status              text NOT NULL,
        invalid_reason      text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        consumed_at         timestamptz,
        revoked_at          timestamptz
      );
      CREATE INDEX IF NOT EXISTS subaccount_approval_sessions_status_idx
        ON subaccount_approval_sessions (status);
    `,
  },
  {
    name: "0015_subaccount_approval_single_active",
    sql: `
      -- 활성(PREPARED/OWNER_SIGNATURE_READY) 세션은 main_account당 최대 1개 —
      -- 동시 prepare 경합 시 DB 수준에서 하나만 성공 (fail-closed).
      CREATE UNIQUE INDEX IF NOT EXISTS subaccount_approval_sessions_single_active_idx
        ON subaccount_approval_sessions (main_account)
        WHERE status IN ('PREPARED', 'OWNER_SIGNATURE_READY');
    `,
  },
  {
    name: "0016_relay_tasks_and_revoke_purpose",
    sql: `
      -- GMX delegated trading 3단계 — durable relay lifecycle + revoke 세션.
      CREATE TABLE IF NOT EXISTS relay_tasks (
        id                  text PRIMARY KEY,
        idempotency_key     text NOT NULL,
        intent_id           text,
        approval_session_id text,
        kind                text NOT NULL,
        status              text NOT NULL,
        payload_hash        text NOT NULL,
        calldata_hash       text,
        relay_task_id       text,
        tx_hash             text,
        order_key           text,
        fee_token           text,
        fee_amount          text,
        user_nonce          text,
        approval_nonce      text,
        error_class         text,
        resolution_basis    text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        resolved_at         timestamptz
      );
      -- 같은 idempotency key 중복 제출 금지 (DB 수준 최종 방어)
      CREATE UNIQUE INDEX IF NOT EXISTS relay_tasks_idempotency_key_idx
        ON relay_tasks (idempotency_key);
      CREATE INDEX IF NOT EXISTS relay_tasks_status_idx ON relay_tasks (status);

      -- 승인 세션에 purpose(APPROVAL|REVOKE) 추가.
      ALTER TABLE subaccount_approval_sessions
        ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'APPROVAL';
      -- REVOKE 세션 전용: RemoveSubaccount digest 재계산용 relayParams 구성값
      ALTER TABLE subaccount_approval_sessions
        ADD COLUMN IF NOT EXISTS relay_fee_token text;
      ALTER TABLE subaccount_approval_sessions
        ADD COLUMN IF NOT EXISTS relay_fee_amount text;
      ALTER TABLE subaccount_approval_sessions
        ADD COLUMN IF NOT EXISTS relay_user_nonce text;
      -- 단일 활성 세션 인덱스를 (main_account, purpose) 기준으로 재구성 —
      -- APPROVAL 활성 세션과 REVOKE 활성 세션은 별개로 각각 1개까지.
      DROP INDEX IF EXISTS subaccount_approval_sessions_single_active_idx;
      CREATE UNIQUE INDEX IF NOT EXISTS subaccount_approval_sessions_single_active_idx
        ON subaccount_approval_sessions (main_account, purpose)
        WHERE status IN ('PREPARED', 'OWNER_SIGNATURE_READY');
    `,
  },
  {
    name: "0017_relay_nonces",
    sql: `
      -- GMX delegated trading 4단계 — durable userNonce allocation.
      -- (main_account, nonce) unique가 다중 프로세스 동시 allocation의 최종 방어.
      CREATE TABLE IF NOT EXISTS relay_nonces (
        id           text PRIMARY KEY,
        main_account text NOT NULL,
        nonce        text NOT NULL,
        purpose      text NOT NULL,
        task_id      text,
        allocated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS relay_nonces_account_nonce_idx
        ON relay_nonces (main_account, nonce);
      CREATE INDEX IF NOT EXISTS relay_nonces_account_idx ON relay_nonces (main_account);
    `,
  },
  {
    name: "0018_relay_tasks_transport_gen",
    sql: `
      -- 6F-2 §3 — transport 세대 구분. 기존 행은 legacy REST(api.gelato.digital)
      -- 세대의 taskId — 신형 JSON-RPC endpoint로 절대 조회하면 안 된다.
      ALTER TABLE relay_tasks
        ADD COLUMN IF NOT EXISTS transport_gen text NOT NULL DEFAULT 'legacy-digital';
    `,
  },
  {
    name: "0019_relay_tasks_gmx_api_v2",
    sql: `
      -- 6G-1 §9 — 공식 GMX API v2 경로(transport_gen='GMX_API_V2') 전용 additive 컬럼.
      -- 기존 Gelato 직접 세대(legacy-digital / jsonrpc-gasless-0.0.10) 행은 보존,
      -- fail-closed 조회 전용(LEGACY_DISABLED)으로만 취급한다.
      ALTER TABLE relay_tasks
        ADD COLUMN IF NOT EXISTS gmx_request_id        text,
        ADD COLUMN IF NOT EXISTS gmx_idempotency_key   text,
        ADD COLUMN IF NOT EXISTS gmx_api_status        text,
        ADD COLUMN IF NOT EXISTS gmx_execution_tx_hash text,
        ADD COLUMN IF NOT EXISTS gmx_order_keys        text,
        ADD COLUMN IF NOT EXISTS gmx_api_peer          text,
        ADD COLUMN IF NOT EXISTS prepared_payload_hash text;
      CREATE UNIQUE INDEX IF NOT EXISTS relay_tasks_gmx_request_id_idx
        ON relay_tasks (gmx_request_id) WHERE gmx_request_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS relay_tasks_gmx_idempotency_key_idx
        ON relay_tasks (gmx_idempotency_key) WHERE gmx_idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS relay_tasks_gmx_api_status_idx
        ON relay_tasks (gmx_api_status) WHERE gmx_api_status IS NOT NULL;
    `,
  },
  {
    name: "0020_relay_tasks_prepare_durability",
    sql: `
      -- 6G-3 §3·§5 — prepare 단계 durable 상태 머신 additive 증거 컬럼.
      -- 상태 값 추가(PREPARE_REQUESTED/API_PREPARED)는 text 컬럼이라 스키마 변경 불필요.
      -- 비민감 증거만: primaryType·typed-data digest·prepare 시각·prepare peer host.
      ALTER TABLE relay_tasks
        ADD COLUMN IF NOT EXISTS gmx_primary_type      text,
        ADD COLUMN IF NOT EXISTS gmx_typed_data_digest text,
        ADD COLUMN IF NOT EXISTS gmx_prepare_peer      text,
        ADD COLUMN IF NOT EXISTS gmx_prepare_requested_at timestamptz,
        ADD COLUMN IF NOT EXISTS gmx_prepared_at       timestamptz;
    `,
  },
  {
    name: "0021_trades_settlement",
    sql: `
      -- 6H-2 §5 — 실제 정산 PnL additive 컬럼. gross/각 fee/net 구분 저장.
      -- 기존 행(전부 PAPER 시뮬 또는 잠금 상태 LIVE TEST 시뮬)은 수수료 0 정의
      -- 시뮬 체결이므로 PAPER_ZERO_FEE로 backfill — 이후 신규 LIVE 정산은
      -- UNSETTLED로 시작해 온체인 증거 확보 후 SETTLED로 전환된다.
      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS gross_pnl_usd      numeric(18,8),
        ADD COLUMN IF NOT EXISTS position_fee_usd   numeric(18,8),
        ADD COLUMN IF NOT EXISTS execution_fee_usd  numeric(18,8),
        ADD COLUMN IF NOT EXISTS price_impact_usd   numeric(18,8),
        ADD COLUMN IF NOT EXISTS funding_fee_usd    numeric(18,8),
        ADD COLUMN IF NOT EXISTS borrowing_fee_usd  numeric(18,8),
        ADD COLUMN IF NOT EXISTS net_pnl_usd        numeric(18,8),
        ADD COLUMN IF NOT EXISTS settlement_status  text NOT NULL DEFAULT 'UNSETTLED',
        ADD COLUMN IF NOT EXISTS settled_at         timestamptz,
        ADD COLUMN IF NOT EXISTS evidence_tx_hash   text;
      -- backfill은 1회만 실행 (worker_state 플래그 가드) — 매 startup 재실행 시
      -- 신규 LIVE UNSETTLED 거래를 정산 확정으로 오염시키는 것을 방지한다.
      UPDATE trades SET settlement_status = 'PAPER_ZERO_FEE'
        WHERE settlement_status = 'UNSETTLED' AND evidence_tx_hash IS NULL
          AND NOT EXISTS (SELECT 1 FROM worker_state WHERE key = 'settlementBackfill0021Done');
      INSERT INTO worker_state (key, value) VALUES ('settlementBackfill0021Done', 'true')
        ON CONFLICT (key) DO NOTHING;
      -- 동일 온체인 증거로 이중 정산 금지 (§5)
      CREATE UNIQUE INDEX IF NOT EXISTS trades_evidence_tx_hash_idx
        ON trades (evidence_tx_hash) WHERE evidence_tx_hash IS NOT NULL;
    `,
  },
  {
    name: "0022_trades_paper_cost_binding",
    sql: `
      -- 6H-2A §3·§4 — PAPER 추정비용 결속 additive 컬럼.
      -- PAPER_ZERO_FEE(무비용 정의)는 폐기 — 신규 PAPER 거래는 PAPER_ESTIMATED로
      -- 저장되며 추정 순 PnL(net_pnl_estimated_usd)이 이익 목표 산정에 사용된다.
      -- 기존 PAPER_ZERO_FEE 행은 legacy로 잔존 (실행 경로에서 정상 source로 미인정).
      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS cost_source             text,
        ADD COLUMN IF NOT EXISTS est_entry_cost_usd      numeric(18,8),
        ADD COLUMN IF NOT EXISTS est_exit_cost_usd       numeric(18,8),
        ADD COLUMN IF NOT EXISTS est_holding_cost_usd    numeric(18,8),
        ADD COLUMN IF NOT EXISTS funding_rate_per_hour   numeric(18,12),
        ADD COLUMN IF NOT EXISTS borrowing_rate_per_hour numeric(18,12),
        ADD COLUMN IF NOT EXISTS cost_fetched_at         timestamptz,
        ADD COLUMN IF NOT EXISTS net_pnl_estimated_usd   numeric(18,8);
    `,
  },
  {
    name: "0023_protection_orders",
    sql: `
      -- 6H-2B §3 — durable 보호 주문 모델 (additive).
      CREATE TABLE IF NOT EXISTS protection_orders (
        id                    text PRIMARY KEY,
        parent_open_intent_id text NOT NULL,
        position_key          text NOT NULL,
        purpose               text NOT NULL,
        symbol                text NOT NULL,
        market_address        text NOT NULL,
        is_long               boolean NOT NULL,
        size_delta_usd        numeric(18,4) NOT NULL,
        trigger_price_usd     numeric(18,8),
        acceptable_price_usd  numeric(18,8),
        day_key               text NOT NULL,
        status                text NOT NULL,
        request_id            text,
        order_key             text,
        typed_data_digest     text,
        evidence              text,
        error                 text,
        submit_attempts       integer NOT NULL DEFAULT 0,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      );
      -- position/purpose당 활성(non-terminal) 보호 주문 정확히 1개 (DB 강제)
      CREATE UNIQUE INDEX IF NOT EXISTS uq_protection_active
        ON protection_orders (position_key, purpose)
        WHERE status IN ('PLANNED','PREPARED','SUBMITTING','SUBMITTED','ACTIVE','UNRESOLVED','FROZEN');
      CREATE INDEX IF NOT EXISTS idx_protection_parent
        ON protection_orders (parent_open_intent_id);
      CREATE INDEX IF NOT EXISTS idx_protection_status
        ON protection_orders (status);
    `,
  },
  {
    name: "0024_protection_evidence",
    sql: `
      -- 6H-2C §3·§4·§6 — decimals·온체인 증거·action budget 스냅샷 (additive, idempotent).
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS decimals_used integer;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS decimals_source text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS decimals_token_address text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS decimals_verified_at timestamptz;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS emitter_address text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS created_tx_hash text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS executed_tx_hash text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS cancelled_tx_hash text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS frozen_tx_hash text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS evidence_block_number text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS action_budget_snapshot text;
      -- emergency close 중복 방어 보강: purpose별 시도 이력 조회용
      CREATE INDEX IF NOT EXISTS idx_protection_position_purpose
        ON protection_orders (position_key, purpose);
    `,
  },
  {
    name: "0025_protection_semantics",
    sql: `
      -- 6H-2D §2·§3·§4 — autoCancel 인코딩값·의미 결속·receipt 증거 (additive, idempotent).
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS auto_cancel_encoded boolean;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS semantic_binding_ok boolean;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS semantic_mismatches text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS receipt_status text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS receipt_block_number text;
      ALTER TABLE protection_orders ADD COLUMN IF NOT EXISTS ambiguous_reason text;
    `,
  },
  {
    name: "0026_market_intelligence_shadow",
    sql: `
      -- 6I-1 §12 — Market Intelligence·Opportunity·Shadow 영속화 (additive, idempotent).
      CREATE TABLE IF NOT EXISTS market_intelligence_snapshots (
        id text PRIMARY KEY,
        cycle_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        universe_count integer NOT NULL,
        shortlist_count integer NOT NULL,
        regime_json text NOT NULL,
        data_quality text NOT NULL,
        degraded_reason text,
        decision text NOT NULL,
        no_trade_reasons text,
        snapshot_hash text NOT NULL,
        full_json text
      );
      CREATE INDEX IF NOT EXISTS idx_mi_snapshots_created ON market_intelligence_snapshots (created_at);

      CREATE TABLE IF NOT EXISTS opportunity_candidates (
        id text PRIMARY KEY,
        snapshot_id text NOT NULL,
        cycle_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at_ms numeric(16,0) NOT NULL,
        symbol text NOT NULL,
        market_address text NOT NULL,
        direction text NOT NULL,
        regime text NOT NULL,
        data_quality text NOT NULL,
        raw_signal_score numeric(10,4) NOT NULL,
        win_probability numeric(8,6),
        calibration_status text NOT NULL,
        expected_entry_price numeric(18,8),
        stop_price numeric(18,8),
        take_profit_price numeric(18,8),
        final_notional_usd numeric(18,4),
        expected_net_value_usd numeric(18,6),
        expected_r_multiple numeric(10,4),
        uncalibrated_ranking_score numeric(10,4),
        total_expected_cost_usd numeric(18,6),
        cost_breakdown_json text,
        feature_json text,
        rank integer,
        selected boolean NOT NULL DEFAULT false,
        decision text NOT NULL,
        rejection_reasons text
      );
      CREATE INDEX IF NOT EXISTS idx_oc_snapshot ON opportunity_candidates (snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_oc_created ON opportunity_candidates (created_at);
      CREATE INDEX IF NOT EXISTS idx_oc_decided_at ON opportunity_candidates (decided_at_ms);

      CREATE TABLE IF NOT EXISTS shadow_outcomes (
        id text PRIMARY KEY,
        candidate_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        measured_at_ms numeric(16,0),
        outcome_1h_net_usd numeric(18,6),
        outcome_4h_net_usd numeric(18,6),
        gross_pnl_4h_usd numeric(18,6),
        total_cost_usd numeric(18,6),
        max_favorable_excursion_pct numeric(10,4),
        max_adverse_excursion_pct numeric(10,4),
        first_touch text,
        complete boolean NOT NULL DEFAULT false,
        incomplete_reason text
      );
      -- candidate당 outcome 1행 — 중복 enrichment 방지 (idempotent)
      CREATE UNIQUE INDEX IF NOT EXISTS uq_shadow_outcome_candidate ON shadow_outcomes (candidate_id);
    `,
  },
  {
    name: "0027_intel_runtime_hardening",
    sql: `
      -- 6I-2 §3·§7 — cycle 상태·durable identity·outcome per-horizon 상태 (additive, idempotent).
      ALTER TABLE market_intelligence_snapshots ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'SUCCESS';
      ALTER TABLE market_intelligence_snapshots ADD COLUMN IF NOT EXISTS started_at_ms numeric(16,0);
      ALTER TABLE market_intelligence_snapshots ADD COLUMN IF NOT EXISTS finished_at_ms numeric(16,0);
      -- 결정적 cycle window key 중복 방어 (재시작 시 같은 window 재실행 idempotent)
      CREATE UNIQUE INDEX IF NOT EXISTS uq_mi_snapshots_cycle ON market_intelligence_snapshots (cycle_id);

      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS outcome_status_1h text;
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS outcome_status_4h text;
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS first_touch_1h text;
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS outcome_1h_gross_usd numeric(18,6);
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS decision_observed_at_ms numeric(16,0);
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS horizon_end_1h_ms numeric(16,0);
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS horizon_end_4h_ms numeric(16,0);
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS source_candle_from_ms numeric(16,0);
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS source_candle_to_ms numeric(16,0);
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS entry_reference_price numeric(18,8);
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS data_coverage numeric(8,6);
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
      ALTER TABLE shadow_outcomes ADD COLUMN IF NOT EXISTS completed_at timestamptz;
    `,
  },
  {
    name: "0028_paper_reset_1000",
    sql: `
      -- 운영자 승인("Production PAPER $1,000 기준값 초기화 승인") 기반 일회성 guarded reset.
      -- docs/production-reset-plan-6h1.md의 트랜잭션을 embedded migration으로 이식.
      -- 동작:
      --   1) advisory xact lock으로 동시 기동 직렬화 (lock 획득 후 모든 가드 평가 — TOCTOU 제거)
      --   2) APPLIED 감사 기록 존재 → 완전 no-op (재기동 반복 초기화 구조적 불가)
      --   3) legacy 지문(Production 2026-08-18 관측값) 전부 일치 + 활동 0건 + stopCoverage 미해결 없음
      --      → 단일 트랜잭션 적용 (감사 백업 → 적용, 각 단계 행 수 검증)
      --   4) 지문 불일치 → skip 로그(관찰용, 비영구)만 갱신 후 no-op — 다음 기동에 재평가 (재시도 가능)
      -- 지문이 일치하는데 활동 흔적(포지션/미정산/승인대기/intent/relay/보호주문)·stopCoverage 미해결이
      -- 있거나 행 수가 예상과 다르면 RAISE EXCEPTION → 전체 롤백 + 서버 기동 중단(readiness 닫힘).
      -- trades/ai_decisions/live_approvals/SHADOW 표본은 접촉하지 않는다.
      DO $reset1000$
      DECLARE
        v_audit text; v_sc_rows int;
        v_capital text; v_lev text; v_daily text; v_weekly text; v_maxpos text;
        v_hwm text; v_bd text; v_bw text; v_risk text; v_stopcov text;
        v_open int; v_unsettled int; v_pending int; v_intents int; v_relay int; v_prot int;
        v_rc int;
      BEGIN
        -- 1) 직렬화 — 다중 인스턴스 동시 기동 시 reset 전체가 한 번에 하나만 진행
        PERFORM pg_advisory_xact_lock(hashtext('paper_reset_1000'));

        -- 2) terminal 가드: APPLIED 기록이 있을 때만 영구 no-op (SKIP은 terminal이 아님)
        SELECT value INTO v_audit FROM worker_state WHERE key = 'paperReset1000Audit';
        IF v_audit IS NOT NULL AND (v_audit::json->>'outcome') = 'APPLIED' THEN RETURN; END IF;

        -- 외부 writer TOCTOU 차단 — 이미 실행 중인 worker/타 인스턴스가 count 확인과 커밋 사이에
        -- 활동 레코드를 쓰지 못하도록 관련 테이블을 트랜잭션 종료까지 write-conflict lock으로 고정
        LOCK TABLE trades, live_approvals, execution_intents, relay_tasks, protection_orders,
                   worker_state, strategy_config IN SHARE ROW EXCLUSIVE MODE;

        SELECT count(*) INTO v_sc_rows FROM strategy_config;
        SELECT limits->>'tradingCapital', limits->>'maxLeverage',
               limits->>'dailyLossLimitUSDT', limits->>'weeklyLossLimitUSDT',
               limits->>'maxSimultaneousPositions'
          INTO v_capital, v_lev, v_daily, v_weekly, v_maxpos
          FROM strategy_config LIMIT 1;
        SELECT value INTO v_hwm  FROM worker_state WHERE key = 'equityHwm';
        SELECT value INTO v_bd   FROM worker_state WHERE key = 'equityBaselineDaily';
        SELECT value INTO v_bw   FROM worker_state WHERE key = 'equityBaselineWeekly';
        SELECT value INTO v_risk FROM worker_state WHERE key = 'riskEngineStateV1';

        -- 3) legacy 지문 — Production에서 읽기 전용 감사로 확인된 정확한 이전 값 전부 일치해야 적용
        -- coalesce 필수: 키 부재(NULL)로 조건이 NULL이 되면 skip 분기를 건너뛰는 3치 논리 함정 방지
        IF NOT coalesce((v_sc_rows = 1
            AND v_capital = '24.5' AND v_lev = '10'
            AND v_daily = '500' AND v_weekly = '1500' AND v_maxpos = '5'
            AND v_hwm = '10000'
            AND v_bd  LIKE '%"equity":24.5%'
            AND v_bw  LIKE '%"equity":10000%'
            AND v_risk LIKE '%"riskOperatingState":"HARD_STOPPED"%'), false) THEN
          -- 4) 불일치 → 관찰 로그만 갱신하고 no-op. terminal 아님 — 다음 기동에 재평가되므로
          --    일시적 불일치(직렬화 차이·배포 타이밍)가 정당한 적용 기회를 영구 차단하지 않는다.
          INSERT INTO worker_state (key, value) VALUES ('paperReset1000SkipLog',
            json_build_object('outcome', 'SKIPPED_FINGERPRINT_MISMATCH', 'at', now(),
              'observed', json_build_object('scRows', v_sc_rows, 'tradingCapital', v_capital,
                'maxLeverage', v_lev, 'equityHwm', v_hwm))::text)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
          RETURN;
        END IF;

        -- 사전 조건: 활동 흔적 전부 0건 (지문 일치인데 위반이면 fail-closed — 롤백+기동 중단)
        SELECT count(*) INTO v_open      FROM trades WHERE action = 'OPEN' AND (close_time IS NULL OR close_time = 0);
        SELECT count(*) INTO v_unsettled FROM trades WHERE test_mode = true AND settlement_status = 'UNSETTLED';
        SELECT count(*) INTO v_pending   FROM live_approvals WHERE status = 'PENDING';
        SELECT count(*) INTO v_intents   FROM execution_intents;
        SELECT count(*) INTO v_relay     FROM relay_tasks;
        SELECT count(*) INTO v_prot      FROM protection_orders;
        IF v_open <> 0 OR v_unsettled <> 0 OR v_pending <> 0 OR v_intents <> 0 OR v_relay <> 0 OR v_prot <> 0 THEN
          RAISE EXCEPTION 'paper_reset_1000 사전 조건 위반: open=% unsettled=% pending=% intents=% relay=% protection=%',
            v_open, v_unsettled, v_pending, v_intents, v_relay, v_prot;
        END IF;

        -- stopCoverage fail-closed — 미해결(PENDING/FAILED_CLOSING/UNRESOLVED) 잔존 시 reset 금지
        -- (계획 문서 6H-2 조항: non-COVERED 기록이 있으면 신규 OPEN이 차단되므로 원인 조사 먼저)
        SELECT value INTO v_stopcov FROM worker_state WHERE key = 'stopCoverage';
        IF v_stopcov IS NOT NULL AND (v_stopcov LIKE '%PENDING%'
            OR v_stopcov LIKE '%FAILED_CLOSING%' OR v_stopcov LIKE '%UNRESOLVED%') THEN
          RAISE EXCEPTION 'paper_reset_1000 사전 조건 위반: stopCoverage 미해결 잔존 — 조사 전 reset 금지';
        END IF;

        -- durable audit backup — 변경 전 원본 값 보존 (민감정보 없음: 설정/파생 상태 값만)
        INSERT INTO worker_state (key, value) VALUES ('paperReset1000Audit',
          json_build_object('outcome', 'APPLIED', 'at', now(),
            'before', json_build_object(
              'tradingCapital', v_capital, 'maxLeverage', v_lev,
              'dailyLossLimitUSDT', v_daily, 'weeklyLossLimitUSDT', v_weekly,
              'maxSimultaneousPositions', v_maxpos, 'equityHwm', v_hwm,
              'equityBaselineDaily', v_bd::json, 'equityBaselineWeekly', v_bw::json,
              'riskEngineStateV1', v_risk::json,
              'stopCoverage', v_stopcov))::text)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

        -- 적용 — 각 단계 행 수 검증, 불일치 시 예외로 전체 롤백
        UPDATE strategy_config SET
          limits = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(limits,
            '{tradingCapital}', '1000'),
            '{maxLeverage}', '3'),
            '{dailyLossLimitUSDT}', '30'),
            '{weeklyLossLimitUSDT}', '80'),
            '{maxSimultaneousPositions}', '1'),
          updated_at = now();
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> 1 THEN RAISE EXCEPTION 'strategy_config UPDATE rows=% (expected 1)', v_rc; END IF;

        UPDATE worker_state SET value = '1000', updated_at = now() WHERE key = 'equityHwm';
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> 1 THEN RAISE EXCEPTION 'equityHwm UPDATE rows=% (expected 1)', v_rc; END IF;

        DELETE FROM worker_state WHERE key = 'riskEngineStateV1';
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> 1 THEN RAISE EXCEPTION 'riskEngineStateV1 DELETE rows=% (expected 1)', v_rc; END IF;

        DELETE FROM worker_state WHERE key IN ('equityBaselineDaily','equityBaselineWeekly');
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> 2 THEN RAISE EXCEPTION 'baseline DELETE rows=% (expected 2)', v_rc; END IF;
      END
      $reset1000$;
    `,
  },
  {
    name: "0029_server_paper_executor",
    sql: `
      -- Task #111 — 서버 권위 PAPER 실행 (additive, 기존 행 무영향)
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS managed_by            text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS open_decision_id      text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS closes_trade_id       text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS close_kind            text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS close_reason          text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS stop_price_usd        numeric(18,8);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS take_profit_price_usd numeric(18,8);

      -- 결정당 OPEN 1회 (idempotent 진입 — 재시작/재시도 중복 OPEN 구조적 차단)
      CREATE UNIQUE INDEX IF NOT EXISTS trades_open_decision_uq
        ON trades (open_decision_id) WHERE open_decision_id IS NOT NULL;

      -- 서버 관리 미청산 포지션 최대 1개 (동시 포지션 1개 제한을 DB가 최종 강제)
      CREATE UNIQUE INDEX IF NOT EXISTS trades_server_single_open_uq
        ON trades ((managed_by)) WHERE managed_by = 'SERVER' AND action = 'OPEN' AND close_time = 0;

      -- OPEN 행당 FULL CLOSE 1회 (중복 전량 청산 구조적 차단; REDUCE70은 예약 게이트가 관리)
      CREATE UNIQUE INDEX IF NOT EXISTS trades_full_close_uq
        ON trades (closes_trade_id) WHERE closes_trade_id IS NOT NULL AND close_kind = 'FULL';
    `,
  },
  {
    name: "0030_close_position_binding",
    sql: `
      -- CLOSE 결산 결속 필드 — trades 테이블 (additive, 기존 행 무영향)
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_account          text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_market_address   text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_collateral_token text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_position_key     text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS pre_close_size_usd          numeric(18,4);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS pre_close_size_usd_30       text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS requested_reduction_usd     numeric(18,4);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS requested_reduction_usd_30  text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_intent_id        text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_relay_task_id    text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_order_key         text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_emitter_address   text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_block_number      text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_latest_block      text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_confirmations     integer;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_evidence_basis    text;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS settlement_evidence_at       timestamptz;
      CREATE UNIQUE INDEX IF NOT EXISTS trades_settlement_intent_uq
        ON trades (settlement_intent_id) WHERE settlement_intent_id IS NOT NULL;

      -- CLOSE 포지션 결속 필드 — execution_intents 테이블 (additive, 기존 행 무영향)
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS close_account                  text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS close_market_address           text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS close_collateral_token         text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS close_position_key             text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS close_pre_size_usd             numeric(18,4);
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS close_pre_size_usd_30          text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS close_requested_reduction_usd  numeric(18,4);
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS close_requested_reduction_usd_30 text;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS close_settlement_trade_id      text;
      CREATE UNIQUE INDEX IF NOT EXISTS execution_intents_close_settlement_trade_uq
        ON execution_intents (close_settlement_trade_id) WHERE close_settlement_trade_id IS NOT NULL;
    `,
  },
  {
    name: "0031_risk_profiles",
    sql: `
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS risk_profile_snapshot jsonb;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS paper_position_slot integer;
      ALTER TABLE execution_intents ADD COLUMN IF NOT EXISTS risk_profile_snapshot jsonb;

      DO $risk_profile_slot_check$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'trades_paper_position_slot_check'
        ) THEN
          ALTER TABLE trades
            ADD CONSTRAINT trades_paper_position_slot_check
            CHECK (paper_position_slot IS NULL OR paper_position_slot IN (1, 2));
        END IF;
      END
      $risk_profile_slot_check$;

      UPDATE trades
      SET paper_position_slot = 1
      WHERE managed_by = 'SERVER'
        AND action = 'OPEN'
        AND close_time = 0
        AND paper_position_slot IS NULL;

      DROP INDEX IF EXISTS trades_server_single_open_uq;

      CREATE UNIQUE INDEX IF NOT EXISTS trades_server_open_slot_uq
        ON trades (paper_position_slot)
        WHERE managed_by = 'SERVER'
          AND action = 'OPEN'
          AND close_time = 0
          AND paper_position_slot IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS trades_server_open_symbol_uq
        ON trades ((upper(symbol)))
        WHERE managed_by = 'SERVER' AND action = 'OPEN' AND close_time = 0;

      CREATE INDEX IF NOT EXISTS trades_risk_profile_name_idx
        ON trades ((risk_profile_snapshot->>'name'))
        WHERE risk_profile_snapshot IS NOT NULL;
    `,
  },
  // Add future migrations here in chronological order.
];

/**
 * Apply all embedded migrations against the database.
 * Every statement is idempotent — safe to run on every API server startup.
 * If any migration fails the error propagates and the caller should abort.
 */
export async function runMigrations(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL! });
  await client.connect();
  try {
    for (const { name, sql } of MIGRATIONS) {
      await client.query(sql);
      console.log(`[db] migration applied: ${name}`);
    }
  } finally {
    await client.end();
  }
}

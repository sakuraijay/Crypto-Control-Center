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

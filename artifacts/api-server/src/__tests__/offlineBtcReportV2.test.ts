import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildOfflineBtcReport,
  buildUnavailableOfflineBtcReport,
} from '../intel/offlineBtcReportBuilderV2';
import offlineBacktestRouter from '../routes/offline-backtest';
import { OFFLINE_BTC_BINANCE_DATASET } from '../intel/fixtures/offlineBtcBinanceDatasetV2';

describe('offline BTC dataset/report boundary', () => {
  it('저장소 evidence 부재를 provenance와 함께 명시적으로 UNAVAILABLE 처리한다', () => {
    const report = buildUnavailableOfflineBtcReport(1_800_000_000_000);
    expect(report.status).toBe('UNAVAILABLE');
    expect(report.provenance.immutable).toBe(true);
    expect(report.provenance.checksumAlgorithm).toBe('SHA-256');
    expect(report.provenance.period).toEqual({ fromMs: null, toMs: null });
    expect(report.issues.join(' ')).toContain('합성');
    expect(report.autoPromotionAllowed).toBe(false);
    expect(report.liveExecutionAuthorized).toBe(false);
  });

  it('빈 데이터셋의 timeframe/cost/risk/checksum/lookback 누락을 숨기지 않는다', () => {
    const report = buildOfflineBtcReport({
      generatedAtMs: 1_800_000_000_000,
      dataset: {
        schemaVersion: 'offline-btc-dataset/v1',
        provenance: {
          datasetId: 'empty',
          source: 'gmx-official-api',
          license: null,
          immutable: true,
          checksumAlgorithm: 'SHA-256',
          checksums: { '15m': null, '1h': null, '4h': null, costs: null, risk: null },
          period: { fromMs: null, toMs: null },
        },
        candles: { '15m': [], '1h': [], '4h': [] },
        costs: [],
        risks: [],
      },
    });
    expect(report.status).toBe('UNAVAILABLE');
    expect(report.walkForward).toBeNull();
    expect(report.issues.join(' ')).toMatch(/OHLCV|timeframe/);
    expect(report.issues.join(' ')).toContain('lookback');
    expect(report.issues.join(' ')).toContain('cost/funding');
  });
});

describe('GET /api/backtest/offline-btc-report bounded contract', () => {
  const app = express().use('/api', offlineBacktestRouter);

  it('외부 조회 없이 modeled/assumed evidence를 명시한 UNAVAILABLE report를 반환한다', async () => {
    const response = await request(app).get('/api/backtest/offline-btc-report?maxFolds=3');
    expect(response.status).toBe(200);
    expect(response.body.provenance.source).toContain('Binance Spot REST');
    expect(response.body.provenance.source).not.toContain('GMX');
    expect(response.body.status).toBe('UNAVAILABLE');
    expect(response.body.walkForward).toBeNull();
    expect(response.body.issues.join(' ')).toContain('cost evidence is MODELED');
    expect(response.body.issues.join(' ')).toContain('risk evidence is ASSUMED');
  });

  it('committed raw Binance response byte checksums match declared artifact checksums', () => {
    const fixtures = {
      '15m': '../intel/fixtures/btc15m.binance-spot.json',
      '1h': '../intel/fixtures/btc1h.binance-spot.json',
      '4h': '../intel/fixtures/btc4h.binance-spot.json',
      funding: '../intel/fixtures/btc-funding.binance-futures.json',
    } as const;
    for (const [key, relative] of Object.entries(fixtures)) {
      const bytes = readFileSync(new URL(relative, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex'))
        .toBe(OFFLINE_BTC_BINANCE_DATASET.provenance.artifactChecksums?.[key as keyof typeof fixtures]);
    }
  });

  it('canonical section checksum mismatch is unavailable rather than silently accepted', () => {
    const report = buildOfflineBtcReport({
      generatedAtMs: OFFLINE_BTC_BINANCE_DATASET.provenance.retrievedAtMs!,
      dataset: {
        ...OFFLINE_BTC_BINANCE_DATASET,
        provenance: { ...OFFLINE_BTC_BINANCE_DATASET.provenance, checksums: {
          ...OFFLINE_BTC_BINANCE_DATASET.provenance.checksums, '15m': '0'.repeat(64),
        } },
      },
    });
    expect(report.status).toBe('UNAVAILABLE');
    expect(report.issues.join(' ')).toContain('checksum 불일치');
  });

  it('unknown/unbounded query를 400으로 거부한다', async () => {
    expect((await request(app).get('/api/backtest/offline-btc-report?maxFolds=21')).status).toBe(400);
    expect((await request(app).get('/api/backtest/offline-btc-report?unknown=1')).status).toBe(400);
    expect((await request(app).get(
      '/api/backtest/offline-btc-report?fromMs=1000&toMs=9999999999999',
    )).status).toBe(400);
  });
});
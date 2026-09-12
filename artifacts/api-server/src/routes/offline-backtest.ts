import { Router, type IRouter } from 'express';
import { buildOfflineBtcReport } from '../intel/offlineBtcReportBuilderV2';
import { OFFLINE_BTC_BINANCE_DATASET } from '../intel/fixtures/offlineBtcBinanceDatasetV2';

const router: IRouter = Router();
const allowed = new Set(['fromMs', 'toMs', 'maxFolds']);

router.get('/backtest/offline-btc-report', (req, res): void => {
  const unknown = Object.keys(req.query).filter(key => !allowed.has(key));
  const fromMs = req.query.fromMs === undefined ? undefined : Number(req.query.fromMs);
  const toMs = req.query.toMs === undefined ? undefined : Number(req.query.toMs);
  const maxFolds = req.query.maxFolds === undefined ? 10 : Number(req.query.maxFolds);
  const invalid = unknown.length > 0
    || (fromMs !== undefined && (!Number.isSafeInteger(fromMs) || fromMs <= 0))
    || (toMs !== undefined && (!Number.isSafeInteger(toMs) || toMs <= 0))
    || (fromMs !== undefined && toMs !== undefined && (toMs <= fromMs || toMs - fromMs > 2 * 365 * 24 * 60 * 60 * 1_000))
    || !Number.isInteger(maxFolds) || maxFolds < 1 || maxFolds > 20;
  if (invalid) {
    res.status(400).json({
      error: 'invalid bounded query',
      contract: { fromMs: 'positive epoch ms', toMs: 'positive epoch ms; max 2 years', maxFolds: 'integer 1..20' },
    });
    return;
  }
  // The report only imports committed repository evidence; it has no network,
  // DB, worker, or execution path.
  res.json(buildOfflineBtcReport({
    generatedAtMs: OFFLINE_BTC_BINANCE_DATASET.provenance.retrievedAtMs!,
    dataset: OFFLINE_BTC_BINANCE_DATASET,
    fromMs, toMs, maxFolds,
  }));
});

export default router;
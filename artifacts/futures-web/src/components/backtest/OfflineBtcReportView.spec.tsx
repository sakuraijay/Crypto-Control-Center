// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { OfflineBtcReportView } from './OfflineBtcReportView';

vi.mock('@/lib/apiUrl', () => ({
  apiUrl: vi.fn((path) => `/api/${path}`),
}));

// Mock Recharts to avoid ResizeObserver errors in JSDOM
vi.mock('recharts', async () => {
  const OriginalRecharts = await vi.importActual<any>('recharts');
  return {
    ...OriginalRecharts,
    ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  };
});

describe('OfflineBtcReportView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('renders loading initially', () => {
    (global.fetch as any).mockImplementation(() => new Promise(() => {})); // Never resolves
    const { container } = render(<OfflineBtcReportView />);
    expect(global.fetch).toHaveBeenCalledWith('/api/backtest/offline-btc-report');
    // Verify skeleton rendered
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders UNAVAILABLE state correctly without fake 0s', async () => {
    const unavailableReport = {
      status: 'UNAVAILABLE',
      generatedAtMs: 1700000000000,
      provenance: {
        datasetId: '',
        source: '',
        license: null,
        immutable: true,
        checksumAlgorithm: 'SHA-256',
        checksums: { '15m': null, '1h': null, '4h': null, costs: null, risk: null },
        period: { fromMs: null, toMs: null },
      },
      evidence: {
        candleCounts: { '15m': 0, '1h': 0, '4h': 0 },
        costCount: 0,
        riskCount: 0,
      },
      issues: ['No immutable evidence'],
      walkForward: null,
      autoPromotionAllowed: false,
      liveExecutionAuthorized: false,
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => unavailableReport,
    });

    render(<OfflineBtcReportView />);
    
    await waitFor(() => {
      expect(screen.getByText('Walk-Forward Data Unavailable')).toBeInTheDocument();
    });

    // Check issues
    expect(screen.getByText('No immutable evidence')).toBeInTheDocument();
    
    // Check that missing provenance renders as "-" (which is our fallback)
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('renders OK state with metrics and tabs', async () => {
    const okReport = {
      status: 'OK',
      generatedAtMs: 1700000000000,
      provenance: {
        datasetId: 'btc-data',
        source: 'local',
        license: null,
        immutable: true,
        checksumAlgorithm: 'SHA-256',
        checksums: { '15m': 'abc', '1h': 'def', '4h': 'ghi', costs: 'jkl', risk: 'mno' },
        period: { fromMs: 1600000000000, toMs: 1700000000000 },
      },
      evidence: {
        candleCounts: { '15m': 100, '1h': 50, '4h': 10 },
        costCount: 10,
        riskCount: 5,
      },
      issues: [],
      walkForward: {
        config: {},
        input: {},
        thresholds: [
          {
            threshold: 60,
            folds: [
              {
                fold: 1,
                trainStartTime: 1600000000000,
                trainEndTime: 1650000000000,
                oosStartTime: 1650000000000,
                oosEndTime: 1700000000000,
                is: { 
                  metrics: { 
                    tradeCount: 5, grossReturnPct: 6.0, netReturnPct: 5.5, winRatePct: 50, 
                    maxDrawdownPct: 5.0, profitFactor: 1.2, expectancyUsd: 50, averageR: 1.0, 
                    sharpe: 1.0, sortino: 1.0, maxConsecutiveWins: 2, maxConsecutiveLosses: 1,
                    costs: { feesUsd: 0, slippageUsd: 0, fundingUsd: 0, borrowingUsd: 0, impactUsd: 0, totalUsd: 0 },
                    equityCurve: [] 
                  }, 
                  trades: [], blocked: {}, breakdown: {} 
                },
                oos: { 
                  metrics: { 
                    tradeCount: 2, grossReturnPct: -1.0, netReturnPct: -1.2, winRatePct: 0,
                    maxDrawdownPct: 1.2, profitFactor: 0.5, expectancyUsd: -10, averageR: -0.5,
                    sharpe: -0.5, sortino: -0.5, maxConsecutiveWins: 0, maxConsecutiveLosses: 2,
                    costs: { feesUsd: 0, slippageUsd: 0, fundingUsd: 0, borrowingUsd: 0, impactUsd: 0, totalUsd: 0 },
                    equityCurve: []
                  }, 
                  trades: [], blocked: {}, breakdown: {} 
                }
              }
            ],
            aggregateOos: {
              metrics: {
                tradeCount: 20,
                grossReturnPct: 15.5,
                netReturnPct: null, // Test null formatting
                winRatePct: 55.5,
                maxDrawdownPct: 10.2,
                profitFactor: 1.5,
                expectancyUsd: 150.5,
                averageR: 1.2,
                sharpe: 1.1,
                sortino: 1.5,
                maxConsecutiveWins: 5,
                maxConsecutiveLosses: 2,
                costs: { feesUsd: 10, slippageUsd: 5, fundingUsd: 2, borrowingUsd: 1, impactUsd: 0, totalUsd: 18 },
                equityCurve: [{ time: 1650000000000, equityUsd: 1000 }]
              },
              blocked: { NO_TRADE: 5 },
              breakdown: {
                month: { '2023-10': { trades: 5, netPnlUsd: 100 } },
                direction: { 'LONG': { trades: 10, netPnlUsd: 200 } },
                strategy: {},
                regime: {},
                profile: {}
              },
              trades: [{ exitReason: 'AMBIGUOUS_STOP_FIRST' }, { exitReason: 'AMBIGUOUS_STOP_FIRST' }, { exitReason: 'TARGET' }]
            }
          }
        ]
      },
      autoPromotionAllowed: false,
      liveExecutionAuthorized: false,
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => okReport,
    });

    render(<OfflineBtcReportView />);

    await waitFor(() => {
      expect(screen.getByText('Task 150 Report')).toBeInTheDocument();
      expect(screen.getByText('Sensitivity: 60')).toBeInTheDocument();
    });

    expect(screen.getByTitle('btc-data')).toBeInTheDocument();
    expect(screen.getByTitle('abc')).toBeInTheDocument();

    // Blocked reason should be rendered
    expect(screen.getByText('NO TRADE')).toBeInTheDocument();
    expect(screen.getAllByText('5').length).toBeGreaterThan(0); // The count for NO TRADE

    // Check newly added things
    expect(screen.getByText('Gross Return')).toBeInTheDocument();
    expect(screen.getByText('Average R')).toBeInTheDocument();
    expect(screen.getByText('Max Cons Wins')).toBeInTheDocument();
    expect(screen.getByText('Max Cons Losses')).toBeInTheDocument();
    expect(screen.getByText('Month')).toBeInTheDocument();
    expect(screen.getByText('AMBIGUOUS STOP FIRST')).toBeInTheDocument();
    expect(screen.getAllByText('2').length).toBeGreaterThan(0); // Count for AMBIGUOUS_STOP_FIRST
    
    // Check fallback for null metrics
    const unavailableTexts = screen.getAllByText('Unavailable');
    expect(unavailableTexts.length).toBeGreaterThan(0);

    // Check locks
    expect(screen.getAllByText('LOCKED').length).toBe(2);
  });
});
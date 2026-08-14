/**
 * GMX V2 market definitions — Arbitrum One (chainId 42161)
 * Mirror of web's markets.ts for use in mobile contexts.
 */

export const ARBITRUM_CHAIN_ID = 42161;

export interface GmxMarket {
  indexSymbol: string;   // e.g. "ETH"
  displaySymbol: string; // e.g. "ETH/USD"
  marketAddress: string;
  indexAddress: string;
  longTokenAddress: string;
  shortTokenAddress: string;
}

export const GMX_MARKETS: GmxMarket[] = [
  {
    indexSymbol: 'ETH',
    displaySymbol: 'ETH/USD',
    marketAddress: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
    indexAddress:  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    longTokenAddress:  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    shortTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    indexSymbol: 'BTC',
    displaySymbol: 'BTC/USD',
    marketAddress: '0x47c031236e19d024b42f8AE6780E44A573170703',
    indexAddress:  '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    longTokenAddress:  '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    shortTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    indexSymbol: 'SOL',
    displaySymbol: 'SOL/USD',
    marketAddress: '0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9',
    indexAddress:  '0x2bcC6D6CdBbDC0a4071e48bb3B969b06B3330c07',
    longTokenAddress:  '0x2bcC6D6CdBbDC0a4071e48bb3B969b06B3330c07',
    shortTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    indexSymbol: 'ARB',
    displaySymbol: 'ARB/USD',
    marketAddress: '0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407',
    indexAddress:  '0x912CE59144191C1204E64559FE8253a0e49E6548',
    longTokenAddress:  '0x912CE59144191C1204E64559FE8253a0e49E6548',
    shortTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    indexSymbol: 'LINK',
    displaySymbol: 'LINK/USD',
    marketAddress: '0x7f1fa204bb700853D36994DA19F830b6Ad18d88',
    indexAddress:  '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    longTokenAddress:  '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    shortTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    indexSymbol: 'AVAX',
    displaySymbol: 'AVAX/USD',
    marketAddress: '0xff6723927d012a24df17be44f90ff95a4bcd4a0',
    indexAddress:  '0x565609fAF65B92F7be02468acF86f8979423e514',
    longTokenAddress:  '0x565609fAF65B92F7be02468acF86f8979423e514',
    shortTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    indexSymbol: 'DOGE',
    displaySymbol: 'DOGE/USD',
    marketAddress: '0x6853EA96FF216fAb11D2d930CE3C508556A4bdc4',
    indexAddress:  '0xC4da4c24fd591125c3F47b340b6f4f76111883d8',
    longTokenAddress:  '0xC4da4c24fd591125c3F47b340b6f4f76111883d8',
    shortTokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
];

export const MARKET_BY_SYMBOL = new Map<string, GmxMarket>(
  GMX_MARKETS.map(m => [m.indexSymbol, m])
);

export function displaySymbol(indexSymbol: string): string {
  return MARKET_BY_SYMBOL.get(indexSymbol)?.displaySymbol ?? `${indexSymbol}/USD`;
}

export const DEFAULT_WATCHLIST_SYMBOLS = ['BTC', 'ETH', 'SOL', 'ARB', 'LINK'];

export const FALLBACK_PRICES: Record<string, number> = {
  ETH: 1877, BTC: 43856, SOL: 101,
  ARB: 0.52, LINK: 14.5, AVAX: 25, DOGE: 0.093,
};

export const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

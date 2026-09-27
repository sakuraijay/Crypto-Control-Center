/**
 * GMX V2 Arbitrum One マーケットアドレス (サーバーサイド参照用)
 * artifacts/futures-web/src/lib/gmx/markets.ts と同期すること.
 */

export interface GmxMarketInfo {
  name:         string;
  marketToken:  string; // market address (pool token)
  indexToken:   string;
  longToken:    string;
  shortToken:   string;
}

export const GMX_MARKETS_SERVER: GmxMarketInfo[] = [
  {
    name: 'ETH/USD',
    marketToken: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
    indexToken:  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    longToken:   '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    shortToken:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    name: 'BTC/USD',
    marketToken: '0x7C11F78Ce78768518D743E81Fdfa2F860C6b9A77',
    indexToken:  '0x47904963fc8b2340414262125aF798B9655E58Cd',
    longToken:   '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    shortToken:  '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  },
  {
    name: 'SOL/USD',
    marketToken: '0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9',
    indexToken:  '0x2bcC6D6CdBbDC0a4071e48bb3B969b06B3330c07',
    longToken:   '0x2bcC6D6CdBbDC0a4071e48bb3B969b06B3330c07',
    shortToken:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    name: 'ARB/USD',
    marketToken: '0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407',
    indexToken:  '0x912CE59144191C1204E64559FE8253a0e49E6548',
    longToken:   '0x912CE59144191C1204E64559FE8253a0e49E6548',
    shortToken:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    name: 'LINK/USD',
    marketToken: '0x7f1fa204bb700853D36994DA19F830b6Ad18455C',
    indexToken:  '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    longToken:   '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    shortToken:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    name: 'AVAX/USD',
    marketToken: '0x7BbBf946883a5701350007320F525c5379B8178A',
    indexToken:  '0x565609fAF65B92F7be02468acF86f8979423e514',
    longToken:   '0x565609fAF65B92F7be02468acF86f8979423e514',
    shortToken:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    name: 'DOGE/USD',
    marketToken: '0x6853EA96FF216fAb11D2d930CE3C508556A4bdc4',
    indexToken:  '0xC4da4c24fd591125c3F47b340b6f4f76111883d8',
    longToken:   '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    shortToken:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
];

export const MARKET_BY_SYMBOL_SERVER = new Map<string, GmxMarketInfo>(
  GMX_MARKETS_SERVER.map(m => [m.name.split('/')[0], m])
);

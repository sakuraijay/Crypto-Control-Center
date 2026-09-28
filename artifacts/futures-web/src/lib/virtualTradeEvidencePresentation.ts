export interface TradeEntryEvidence {
  source:string;evaluatedAt:number;closedAt:number;momentumPct:number|null;
  quality:{regime:string|null;eligible:boolean|null;reason:string|null;efficiency:number|null;atrPct:number|null};
  patternStatus:string;patternVersion:string|null;patternAdjustment:number|null;
  frames:{timeframe:string;status:string;closedAt:number|null;bars:number|null;volumeConfirmation:string;
    findings:{id:string;direction:string;state:string;availableAt:number;alignment:string;trigger:number|null;invalidation:number|null;basis:string|null}[]}[];
}
const labels:Record<string,string>={
  DOJI:'도지',DRAGONFLY_DOJI:'잠자리 도지',GRAVESTONE_DOJI:'비석 도지',SPINNING_TOP:'팽이형 캔들',
  HAMMER:'망치형',HANGING_MAN:'교수형',INVERTED_HAMMER:'역망치형',SHOOTING_STAR:'유성형',
  BULLISH_MARUBOZU:'상승 장대 몸통형',BEARISH_MARUBOZU:'하락 장대 몸통형',
  BULLISH_ENGULFING:'상승 장악형',BEARISH_ENGULFING:'하락 장악형',BULLISH_HARAMI:'상승 잉태형',BEARISH_HARAMI:'하락 잉태형',
  PIERCING:'관통형',DARK_CLOUD_COVER:'먹구름형',MORNING_STAR:'샛별형',EVENING_STAR:'석별형',
  THREE_WHITE_SOLDIERS:'적삼병',THREE_BLACK_CROWS:'흑삼병',DOUBLE_TOP:'쌍봉',DOUBLE_BOTTOM:'쌍바닥',
  TRIPLE_TOP:'삼중 천장',TRIPLE_BOTTOM:'삼중 바닥',HEAD_SHOULDERS:'헤드앤숄더',INVERSE_HEAD_SHOULDERS:'역헤드앤숄더',
  ASCENDING_TRIANGLE:'상승 삼각형',DESCENDING_TRIANGLE:'하락 삼각형',SYMMETRICAL_TRIANGLE:'대칭 삼각형',
  RISING_WEDGE:'상승 쐐기',FALLING_WEDGE:'하락 쐐기',RECTANGLE:'박스권',BROADENING:'확산형',PRICE_CHANNEL:'가격 채널',
  BULL_FLAG:'상승 깃발형',BEAR_FLAG:'하락 깃발형',BULL_PENNANT:'상승 페넌트',BEAR_PENNANT:'하락 페넌트',
};
export const patternName=(id:string)=>labels[id]??id;
export const timeframeName=(tf:string)=>({'15m':'15분봉','1h':'1시간봉','4h':'4시간봉'}[tf]??tf);
export const patternAlignment=(value:string)=>({SUPPORTS:'진입 방향 지지',OPPOSES:'진입 방향과 반대',NEUTRAL:'방향 중립'}[value]??'미확인');
export const frameStatus=(value:string)=>({OK:'분석 완료',UNAVAILABLE:'자료 부족',INVALID:'자료 검증 실패',STALE:'자료 만료'}[value]??'미확인');
export const regimeName=(value:string|null)=>({TREND:'추세',RANGE:'횡보',TRANSITION:'전환 구간'}[value??'']??'기록 없음');
const basisLabels:Record<string,string>={
  'body <= 10% of range; indecision, not directional confirmation':'몸통이 전체 봉 길이의 10% 이하인 중립 형태입니다.',
  'small body with two wicks':'작은 몸통 양쪽에 꼬리가 나타났습니다.',
  'lower wick >= 2 bodies; prior five-bar trend':'이전 5개 봉 추세와 몸통 2배 이상의 아래꼬리를 확인했습니다.',
  'upper wick >= 2 bodies; prior five-bar trend':'이전 5개 봉 추세와 몸통 2배 이상의 위꼬리를 확인했습니다.',
  'body >= 90% range and 0.7 ATR':'몸통이 전체 봉 길이의 90% 이상이며 최근 평균 변동폭의 0.7배를 넘었습니다.',
  'opposite body engulfment after prior trend':'이전 추세와 반대 방향의 몸통이 직전 봉 몸통을 감쌌습니다.',
  'small opposite body contained in prior body':'반대 방향의 작은 몸통이 직전 봉 몸통 안에 들어왔습니다.',
  'close recovers midpoint after downtrend':'하락 추세 뒤 직전 몸통의 중간값 위에서 마감했습니다.',
  'close loses midpoint after uptrend':'상승 추세 뒤 직전 몸통의 중간값 아래에서 마감했습니다.',
  'three-body reversal, continuous-market gap relaxation':'큰 몸통·작은 몸통·반대 방향 몸통의 3개 봉 조합입니다. 24시간 시장에 맞춘 갭 완화 규칙입니다.',
  'three rising strong bodies after downtrend':'하락 추세 이후 강한 상승 몸통 3개가 연속으로 나타났습니다.',
  'three falling strong bodies after uptrend':'상승 추세 이후 강한 하락 몸통 3개가 연속으로 나타났습니다.',
  'confirmed spaced pivots, prior trend, neckline close break':'확정된 고점·저점의 간격과 유사성, 이전 추세, 종가의 목선 돌파를 확인했습니다.',
  'three confirmed peaks, central extreme, sloped neckline close break':'가운데가 가장 극단적인 세 고점·저점과 기울어진 목선의 종가 돌파를 확인했습니다.',
  'three confirmed touches per boundary; fresh close beyond fitted line':'위·아래 경계에 각각 3번의 확정 접촉 후 종가가 경계선을 새로 돌파했습니다.',
  'prior eight-bar pole > 4 ATR; consolidation < half pole; continuation close break':'앞선 8개 봉의 강한 움직임과 제한된 조정 후 같은 방향의 종가 돌파를 확인했습니다.',
};
export const patternBasis=(basis:string|null)=>basis?basisLabels[basis]??basis:'세부 탐지 조건 기록 없음';
export function entryPatternSummary(e:TradeEntryEvidence|null|undefined):string {
  if(!e||e.patternStatus!=='RECORDED')return '패턴 기록 없음';
  const found=e.frames.flatMap(f=>f.findings.map(p=>`${timeframeName(f.timeframe)} ${patternName(p.id)}`));
  if(found.length)return found.slice(0,2).join(' · ')+(found.length>2?` 외 ${found.length-2}개`:'');
  return e.frames.some(f=>f.status==='OK')?'분석 완료 · 감지 패턴 없음':'패턴 분석 자료 부족';
}

import type {PatternDefinition} from '@/lib/patternCatalog';
/** Schematic vectors only: no real market data or fabricated detections. */
export function PatternPreview({pattern:p}:{pattern:PatternDefinition}) {
  const color=p.direction==='SHORT'?'#f38e91':p.direction==='NEUTRAL'?'#a7b9cc':'#8be0b4';
  const x=(v:number)=>16+v*1.68,y=(v:number)=>98-v*.8;
  return <svg viewBox="0 0 200 116" role="img" aria-label={`${p.id} 설명용 패턴 그림`} className="w-full" style={{maxHeight:220}}>
    {[30,60,90].map(v=><line key={v} x1="10" x2="190" y1={v} y2={v} stroke="#29323b" strokeWidth=".6"/>)}
    {p.guides?.map((g,i)=><polyline key={i} points={g.map(([a,b])=>`${x(a)},${y(b)}`).join(' ')} fill="none" stroke="#9aabb4" strokeWidth="1" strokeDasharray="4 4"/>)}
    {p.line&&<polyline points={p.line.map(([a,b])=>`${x(a)},${y(b)}`).join(' ')} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>}
    {p.candles?.map(([o,h,l,c],i)=>{
      const cx=100+(i-(p.candles!.length-1)/2)*40,fill=c>o?'#8be0b4':c<o?'#f38e91':'#a7b9cc';
      return <g key={i}><line x1={cx} x2={cx} y1={y(h)} y2={y(l)} stroke={fill} strokeWidth="2"/>
        <rect x={cx-10} y={y(Math.max(o,c))} width="20" height={Math.max(2,Math.abs(y(o)-y(c)))} fill={fill} rx="1.5"/></g>;
    })}
  </svg>;
}

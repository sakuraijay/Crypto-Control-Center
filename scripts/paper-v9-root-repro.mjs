#!/usr/bin/env node
// Read-only source/candle reproduction. Does not import the worker, DB or app.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const baselineSha='e8a6502618a2e971c6e5f91a3d43dcea2aff71bd';
const folder='docs/verification/paper-v9';
const source=execFileSync('git',['show',`${baselineSha}:artifacts/api-server/src/workers/virtualPaperDailyCandidate.ts`],{encoding:'utf8'});
const captures=JSON.parse(await readFile(`${folder}/root-candles.json`,'utf8'));
const observation=JSON.parse(await readFile(`${folder}/root-observation.json`,'utf8'));
const temp=await mkdtemp(join(tmpdir(),'paper-stop-root-'));
try {
  const modulePath=join(temp,'candidate.ts');
  const require=createRequire(new URL('../artifacts/api-server/package.json',import.meta.url));
  const {transform}=require('esbuild');
  const compiled=await transform(source,{loader:'ts',format:'esm'});
  const executablePath=modulePath.replace(/\.ts$/,'.mjs');
  await writeFile(executablePath,compiled.code);
  const {dailyPaperCandidate}=await import(pathToFileURL(executablePath).href);
  const results=[];
  for(const [symbol,capture] of Object.entries(captures)){
    if(capture.httpStatus!==200 || !Array.isArray(capture.body.candles))throw Error('CANDLE_CAPTURE_UNAVAILABLE');
    const raw={source:'gmx-official-api',prices:capture.body.candles};
    // Requested historical 21:33 PHT. Exact then-current quote is not retained:
    // never relabel the completed-candle reference price as an executed entry.
    const historicalAt=Date.parse('2026-10-02T13:33:00Z');
    const historical=dailyPaperCandidate(symbol,raw,historicalAt);
    const tick=observation.prices.body.find(t=>t.tokenSymbol===symbol);
    const observedAt=Date.parse(observation.prices.capturedAt);
    const observed=dailyPaperCandidate(symbol,raw,observedAt);
    const sample=(candidate,at,entry,quoteAt)=>{
      const evaluation=candidate?.evaluation;
      const stop=evaluation?.stopPrice??null;
      const signal=evaluation?.signals.find(s=>s.kind===evaluation.selectedSetup);
      const side=signal?.side??candidate?.side??null;
      const distance=Number.isFinite(entry)&&Number.isFinite(stop)&&entry>0&&stop>0
        ?Math.abs(entry-stop)/entry:null;
      const previousReason=distance===null||distance<=0?'V8_STOP_INVALID':evaluation?.reason??'CANDIDATE_UNAVAILABLE';
      return {symbol,evaluatedAt:new Date(at).toISOString(),closedAt:candidate?new Date(candidate.closedAt).toISOString():null,
        direction:side,directionBasis:signal?.side?'SELECTED_SIGNAL':'MOMENTUM_FALLBACK_NOT_ENTRY_PERMISSION',
        referencePrice:candidate?.referencePrice??null,observedEntryQuote:entry,quoteObservedAt:quoteAt,
        stopPrice:stop,stopDistance:distance,selectedSetup:evaluation?.selectedSetup??null,
        selectedScore:evaluation?.selectedScore??null,signalEligible:evaluation?.eligible??false,
        candidateReason:evaluation?.reason??'CANDIDATE_UNAVAILABLE',previousReportedReason:previousReason,
        signalDetails:evaluation?.signals??[],
        root:!evaluation?.selectedSetup?'NO_SELECTED_SIGNAL_STOP_NOT_CONSTRUCTED':
          stop===null?'STRUCTURAL_STOP_FILTERED_NO_PRICE_RETAINED':'ACTUAL_STOP_AVAILABLE_REQUIRES_ENTRY_SIDE_AND_BOUNDS_VALIDATION'};
    };
    results.push({historical:sample(historical,historicalAt,null,null),
      currentObserved:sample(observed,observedAt,tick?.priceUsd??null,tick?new Date(tick.updatedAt).toISOString():null)});
  }
  const report={baselineSha,baselineCandidateSha256:createHash('sha256').update(source).digest('hex'),
    source:'GMX_OFFICIAL_COMPLETED_CANDLES_AND_PUBLIC_READONLY_PRICE_CACHE',results,
    limitations:['Historical 21:33 PHT execution quote was not persisted; reference close is not a fill.',
      'Captured current quotes belong to their recorded observation, not the historical request.',
      'A missing selected signal is not proof of a wrong-side stop. All genuine stop invalidity remains blocked.']};
  await writeFile(`${folder}/stop-root-reproduction.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  await rm(temp,{recursive:true,force:true});
}
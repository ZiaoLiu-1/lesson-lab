export function summarize(runs) {
 const groups=[];
 for(const taskId of ['T1','T2','T3'])for(const lane of ['cerebras','astra','cerebras-qwen']) {
  const cohort=runs.filter(r=>r.phase==='measured'&&r.taskId===taskId&&r.lane===lane);
  const passed=cohort.filter(r=>r.status==='rendered'&&r.review==='pass'&&Number.isFinite(r.browser?.renderedMs));
  const times=passed.map(r=>r.browser.renderedMs).sort((a,b)=>a-b);
  const n=times.length;
  const fingerprints=new Set(cohort.map(r=>JSON.stringify([r.protocolVersion,r.sourceHash,r.promptHash,r.schemaHash,r.stylesHash,r.metadata?.effectiveConfig])));
  const mixedCohort=fingerprints.size>1;
  groups.push({taskId,lane,attempts:cohort.length,reviewedPasses:n,failed:cohort.filter(r=>['failed','cancelled','render_failed'].includes(r.status)||r.review==='fail').length,pending:cohort.filter(r=>!['failed','cancelled','render_failed'].includes(r.status)&&r.review==='pending').length,mixedCohort,medianMs:n&&!mixedCohort?(times[Math.floor((n-1)/2)]+times[Math.floor(n/2)])/2:null,minMs:n&&!mixedCohort?times[0]:null,maxMs:n&&!mixedCohort?times[n-1]:null,promptHashes:[...new Set(cohort.map(r=>r.promptHash))]});
 }
 return {metric:'Per-run dispatch to verified visible update',note:'Rehearsals excluded. Failures remain in attempts. Do not combine task rows or quote p95 from five pairs.',groups};
}
export function toCSV(runs){
 const fields=['runId','pairId','taskId','lane','phase','status','review','startedAt','serverMs','uiResponseMs','renderedMs','model','reasoning','inputTokens','outputTokens','sourceHash','promptHash','error'];
 const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
 return [fields,...runs.map(r=>[r.runId,r.pairId,r.taskId,r.lane,r.phase,r.status,r.review,r.startedAt,r.serverMs,r.browser?.uiResponseMs,r.browser?.renderedMs,r.metadata?.model,r.metadata?.effectiveConfig?.reasoningEffort,r.metadata?.usage?.prompt_tokens??r.metadata?.usage?.input_tokens,r.metadata?.usage?.completion_tokens??r.metadata?.usage?.output_tokens,r.sourceHash,r.promptHash,r.error?.code])].map(row=>row.map(quote).join(',')).join('\n')+'\n';
}

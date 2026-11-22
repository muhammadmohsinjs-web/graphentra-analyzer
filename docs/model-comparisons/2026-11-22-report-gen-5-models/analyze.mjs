import fs from 'node:fs';
const S=process.argv[2];
const price={ds:{p:0.15,c:0.60,cr:0.003},luna:{p:0.10,c:0.50,cr:0.01}}; // $/M tokens (OpenRouter list, off-peak DS)
const rows=[];
for(const f of fs.readdirSync(S+'/runs').filter(f=>f.endsWith('.log'))){
  const m=f.match(/^(ds|luna)\d*-(\w+)\.log$/); const txt=fs.readFileSync(S+'/runs/'+f,'utf8');
  const l=txt.split('\n').find(x=>x.includes('"request.completed"')); if(!l) continue;
  const j=JSON.parse(l); const u=j.usage; const pr=price[m[1]];
  const cached=u.prompt_tokens_details?.cached_tokens??0;
  const cost=((u.prompt_tokens-cached)*pr.p+cached*pr.cr+u.completion_tokens*pr.c)/1e6;
  rows.push({model:m[1],commit:m[2],attempt:j.attempt,ms:j.durationMs,pt:u.prompt_tokens,ct:u.completion_tokens,cached,rcost:u.cost,cost,fin:j.finishReason,mdl:j.model});
}
console.log(JSON.stringify(rows.sort((a,b)=>a.commit.localeCompare(b.commit)||a.model.localeCompare(b.model)),null,0).replace(/\},/g,'},\n'));

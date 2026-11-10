import {createHash,randomUUID} from 'node:crypto';
import {MAX_COUNTER, PRODUCER, validateUsage, validateNumericLog} from '../../shared/bridge-protocol.mjs';
export const hashId = id => createHash('sha256').update(id).digest('hex');
const bucketNames=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'];
const zero=()=>Object.fromEntries(bucketNames.map(k=>[k,0]));
const combine=(a,b,sign=1)=>Object.fromEntries(bucketNames.map(k=>[k,a[k]+sign*b[k]]));
const equal=(a,b)=>a && b && bucketNames.every(k=>a[k]===b[k]);
export function officialUsage(raw) {
  try { return validateUsage({inputTokens:raw.uncachedInputTokens+raw.cacheReadTokens+raw.cacheWriteTokens,outputTokens:raw.outputTokens,cacheReadTokens:raw.cacheReadTokens,cacheWriteTokens:raw.cacheWriteTokens}); } catch { return null; }
}
export function safeTitle(value) {
  if(typeof value !== 'string') return 'DSH 会话';
  const text=value.replace(/\x1b\][^\x07]*(?:\x07|$)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x1f\x7f-\x9f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').replace(/\s+/g,' ').trim();
  // Public title metadata only; recognizable credential-like material is redacted.
  const redacted=text.replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi,'[redacted]');
  let out=''; for(const c of redacted) { if(Buffer.byteLength(out+c)>120) break; out+=c; } return out || 'DSH 会话';
}
function routeOf(event) {
  const source=event?.type === 'assistant/message' ? event.data?.message?.source : null;
  const provider=typeof source?.provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(source.provider) ? source.provider : 'unknown';
  const model=typeof source?.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(source.model) ? source.model : 'unknown';
  return provider === 'unknown' || model === 'unknown' ? {provider:'unknown',model:'unknown'} : {provider,model};
}
const tokenPayload=u=>({input_tokens:u.inputTokens,output_tokens:u.outputTokens,cached_input_tokens:u.cacheReadTokens,cache_write_input_tokens:u.cacheWriteTokens,reasoning_output_tokens:0});
// Cumulative official projection is authoritative. No raw stream/message content is read.
export class UsageAccounting {
  constructor({sessionKey,source='dsh',baseline,at}) {
    this.sessionKey=sessionKey; this.source=source; this.baseline=baseline; this.previous=baseline; this.samples=[]; this.carried=zero(); this.segmentId=randomUUID(); this.slot=null; this.at=at; this.valid=baseline !== null; this.observed=baseline !== null;
  }
  settle(event,official) {
    if(!official) { this.valid=false; return; }
    if(!this.previous || !this.valid) { this.baseline=official; this.previous=official; this.samples=[]; this.carried=zero(); this.segmentId=randomUUID(); this.slot=null; this.valid=true; this.observed=false; return; }
    if(event.type === 'llm/retry-started') { if(this.slot?.turn===event.data?.turn && this.slot?.step===event.data?.step) this.slot=null; return; }
    if(!['assistant/message','assistant/attempt'].includes(event.type)) return;
    const {turn,step}=event.data ?? {};
    if(!Number.isSafeInteger(turn) || turn<0 || !Number.isSafeInteger(step) || step<0) { this.valid=false; return; }
    const replacement=this.slot?.turn===turn && this.slot?.step===step ? this.slot : null;
    try {
      // Rotate only after the replacement slot closes. New opaque shard ids let
      // the consumer retain imported older segments instead of overwriting them.
      if(!replacement && this.samples.length>=120) {
        this.carried=validateUsage(this.samples.reduce((acc,s)=>combine(acc,s.usage),this.carried));
        this.samples=[];this.slot=null;this.segmentId=randomUUID();
      }
      const delta=combine(official,this.previous,-1);
      const sample=validateUsage(combine(delta,replacement?.usage ?? zero()));
      if(replacement) this.samples=this.samples.filter(s=>s!==replacement);
      const item={turn,step,usage:sample,...routeOf(event),at:event.time};
      this.samples.push(item); this.slot=item; this.previous=official; this.at=event.time;
      const sum=this.samples.reduce((acc,s)=>combine(acc,s.usage),this.carried);
      if(!equal(sum,validateUsage(combine(official,this.baseline,-1)))) throw Error('projection mismatch');
      if(this.samples.length>120 || sum.inputTokens+sum.outputTokens>MAX_COUNTER) throw Error('accounting limit');
      this.valid=true; this.observed=true;
    } catch { this.valid=false; this.samples=[]; this.slot=null; this.previous=null; }
  }
  usage() { if(!this.valid || !this.observed) return null; try { return validateUsage(this.samples.reduce((acc,s)=>combine(acc,s.usage),this.carried)); } catch { return null; } }
  logs(epoch) {
    if(!this.valid) return [];
    const routes=new Map();
    for(const sample of this.samples) {
      if(!sample.usage.inputTokens && !sample.usage.outputTokens) continue;
      const key=`${sample.provider}:${sample.model}`;
      if(!routes.has(key)) routes.set(key,[]); routes.get(key).push(sample);
    }
    return [...routes.values()].map(samples=>{
      const first=samples[0], id=hashId(`${this.sessionKey}:${first.provider}:${first.model}:${this.segmentId}`);
      const records=[{timestamp:first.at,type:'session_meta',payload:{id,session_key:this.sessionKey,origin:PRODUCER,epoch,model_provider:first.provider,source:this.source}}];
      let total=zero();
      for(const sample of samples) {
        total=validateUsage(combine(total,sample.usage));
        records.push({timestamp:sample.at,type:'turn_context',payload:{model:sample.model,model_provider:sample.provider,turn_id:String(sample.turn)}});
        records.push({timestamp:sample.at,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:tokenPayload(total),last_token_usage:tokenPayload(sample.usage)}}});
      }
      const text=records.map(r=>JSON.stringify(r)).join('\n')+'\n'; validateNumericLog(text,{epoch,sessionKey:id});
      return {file:`${epoch}-${id}.jsonl`,text};
    });
  }
}

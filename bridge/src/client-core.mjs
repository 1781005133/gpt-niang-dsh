import {unknownQuota, validateQuotaStatus, validateProjection, QUOTA_TTL_MS, MAX_CLOCK_SKEW_MS} from '../../shared/bridge-protocol.mjs';
const labels = {free:'Free',go:'Go',plus:'Plus',pro:'Pro',team:'Team',business:'Business',enterprise:'Enterprise',edu:'Edu'};
export function activeAccountId(response) {
  const s=response?.ok === true ? response.value : null;
  if (s?.authenticated !== true || s.provider !== 'openai-codex' || !Array.isArray(s.accounts) || s.accounts.length > 64) return null;
  const active=s.accounts.filter(a => a?.active === true);
  return active.length === 1 && typeof active[0].id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(active[0].id) ? active[0].id : null;
}
export function publicAccountIdentity(response) {
  const id=activeAccountId(response);if(!id) return null;
  const account=response.value.accounts.find(a=>a.active===true);
  const email=account.email===undefined || account.email===null ? null : account.email;
  if(email!==null && (typeof email!=='string' || email.length>320 || /[\x00-\x1f\x7f]/.test(email))) return null;
  return JSON.stringify([id,email===null ? null : email.trim().toLowerCase()]);
}
export async function accountHash(identity, cryptoApi = globalThis.crypto) {
  const digest=await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(`dsh-gpt-companion:${identity}`));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
}
export function normalizeDshUsage(value, accountKey, now=Date.now()) {
  try {
    if (!value || !Number.isSafeInteger(value.fetchedAt) || value.fetchedAt <= 0 || value.fetchedAt > now + MAX_CLOCK_SKEW_MS || now - value.fetchedAt >= QUOTA_TTL_MS || !Array.isArray(value.rateLimits) || value.rateLimits.length > 32) return unknownQuota('STALE_QUOTA',now);
    const limits=value.rateLimits.filter(l => l?.id === 'codex');
    if (limits.length > 1 || limits.length && (!Array.isArray(limits[0].windows) || limits[0].windows.length > 8)) return unknownQuota('INVALID_WINDOWS',now);
    const windows=(limits[0]?.windows ?? []).map(w => {
      const minutes=w.windowSeconds / 60, used=w.usedPercent;
      const label=minutes === 10080 ? '每周' : minutes % 1440 === 0 ? `${minutes/1440} 天` : minutes % 60 === 0 ? `${minutes/60} 小时` : `${minutes} 分钟`;
      return {label,minutes,used,remaining:100-used,resetsAt:w.resetsAt ?? null};
    }).sort((a,b) => a.minutes-b.minutes);
    if(value.individualLimit !== undefined && value.individualLimit !== null) {
      const raw=value.individualLimit;
      const amount=v=>{
        if(v===undefined || v===null) return null;
        if(typeof v==='string' && (v.length>64 || !/^\d+(?:\.\d+)?$/.test(v)) || typeof v!=='string' && typeof v!=='number') throw Error('invalid individual limit');
        const number=Number(v); if(!Number.isFinite(number) || number<0 || number>1e12) throw Error('invalid individual limit'); return number;
      };
      const total=amount(raw.limit),amountUsed=amount(raw.used);
      const remaining=raw.remainingPercent; // Service percentage only; no inferred entitlement.
      if(typeof remaining!=='number' || !Number.isFinite(remaining) || remaining<0 || remaining>100) return unknownQuota('INVALID_WINDOWS',now);
      windows.unshift({kind:'individual',label:'个人额度',minutes:null,used:100-remaining,remaining,resetsAt:raw.resetsAt ?? null,total,amountUsed,amountRemaining:total!==null && amountUsed!==null ? Math.max(0,total-amountUsed) : null});
    }
    if (!windows.length) return {...unknownQuota('NO_WINDOWS',now),error:'当前账户未提供可显示的额度窗口'};
    const plan=typeof value.planType === 'string' && /^[a-z][a-z_]{0,31}$/.test(value.planType) ? value.planType : null;
    return validateQuotaStatus({ok:true,queryOk:true,source:'dsh',observedAt:value.fetchedAt,accountKey,plan,planLabel:plan ? labels[plan] ?? plan : '未知套餐',planKnown:plan !== null && Object.hasOwn(labels,plan),planSource:plan ? 'rateLimits' : null,authType:'oauth',windows});
  } catch { return unknownQuota('INVALID_WINDOWS',now); }
}
// One serial flight. Controls/status use the same genuine authenticated client.
export function createBridgeClient({connection,now=Date.now,cryptoApi=globalThis.crypto,setTimer=setTimeout,clearTimer=clearTimeout,intervalMs=5000,statusIntervalMs=30000,quotaIntervalMs=60000,timeoutMs=18000,onError=()=>{}}) {
  let stopped=false,leaseId,seq=0,timer,flight,generation,abort,lastStatus=-Infinity,lastQuota=-Infinity,lastVisible=false,knownIdentity;
  const rpc=(method,payload,signal)=>connection.rpc.call('/api',method,payload,signal);
  const available=()=>connection.isLoopback===true && Boolean(connection.generation?.getSnapshot());
  const clearLease=()=>{leaseId=undefined;seq=0;lastStatus=-Infinity;lastQuota=-Infinity;lastVisible=false;knownIdentity=undefined;};
  const control=async(payload,signal)=>{
    const r=await rpc('gpt-companion/control',payload,signal),v=r?.value;
    if(r?.ok!==true || typeof v?.visible!=='boolean' || typeof v?.pending!=='boolean' || typeof v?.granted!=='boolean' || !Number.isSafeInteger(v?.refreshSeq) || v.refreshSeq<0 || v.consumerInstanceId!==null && (typeof v.consumerInstanceId!=='string' || !/^[0-9a-f-]{36}$/.test(v.consumerInstanceId)))throw Error('BRIDGE_UNAVAILABLE');return v;
  };
  const tick=async(checkIdentity=false)=>{
    if(stopped || flight)return flight;clearTimer(timer);if(!available()){clearLease();return;}
    const gen=connection.generation.getSnapshot();abort=new AbortController();const deadline=setTimer(()=>abort.abort(),timeoutMs),signal=abort.signal;
    flight=(async()=>{
      try {
        if(generation!==gen){clearLease();generation=gen;}
        if(!leaseId){const acquired=await rpc('gpt-companion/lease',{action:'acquire'},signal);if(acquired?.ok!==true || typeof acquired.value?.leaseId!=='string')throw Error('BRIDGE_UNAVAILABLE');leaseId=acquired.value.leaseId;}
        let state=await control({leaseId},signal),force=false;
        if(state.visible && state.pending){state=await control({leaseId,claimRefresh:{consumerInstanceId:state.consumerInstanceId,refreshSeq:state.refreshSeq}},signal);force=state.granted;}
        let query=state.visible && (force || !lastVisible || now()-lastQuota>=quotaIntervalMs);lastVisible=state.visible;
        if(!query && !checkIdentity && now()-lastStatus<statusIntervalMs)return;
        let status,identity={accountKey:null,observedAt:now()};
        try {
          const before=publicAccountIdentity(await rpc('codex-subscription/status',{},signal));lastStatus=now();
          if(!before){status=unknownQuota('NO_ACCOUNT',now());knownIdentity=null;}
          else {
            if(state.visible && before!==knownIdentity)query=true;
            const key=await accountHash(before,cryptoApi);
            if(query){
              lastQuota=now();let response;try{response=await rpc('codex-subscription/usage',force?{force:true}:{},signal);}catch{response=null;}
              const after=publicAccountIdentity(await rpc('codex-subscription/status',{},signal));lastStatus=now();
              if(!after || before!==after){status=unknownQuota('ACCOUNT_CHANGED',now());knownIdentity=null;}
              else{identity={accountKey:key,observedAt:now()};knownIdentity=before;status=response?.ok===true?normalizeDshUsage(response.value,key,now()):unknownQuota('QUERY_FAILED',now());}
            }else{identity={accountKey:key,observedAt:now()};knownIdentity=before;}
          }
        }catch{status=unknownQuota('QUERY_FAILED',now());knownIdentity=null;lastStatus=now();}
        if(stopped || signal.aborted || connection.generation.getSnapshot()!==gen)return;
        const payload={leaseId,seq:++seq,identity};if(status)payload.status=status;
        if(force)payload.refreshResult={consumerInstanceId:state.consumerInstanceId,refreshSeq:state.refreshSeq,ok:Boolean(status?.ok),observedAt:status?.ok?status.observedAt:null,errorCode:status?.ok?null:status?.errorCode ?? 'QUERY_FAILED'};
        const response=await rpc('gpt-companion/projection',validateProjection(payload),signal);if(response?.ok!==true)throw Error('BRIDGE_UNAVAILABLE');
      }catch{clearLease();if(!stopped)onError('Bridge connection unavailable');}
      finally{clearTimer(deadline);}
    })().finally(()=>{flight=undefined;if(!stopped && available())timer=setTimer(()=>tick(),intervalMs);});return flight;
  };
  const changed=()=>{abort?.abort();clearLease();clearTimer(timer);if(!stopped)Promise.resolve(flight).finally(()=>tick());};
  const unsubscribe=connection.generation?.subscribe(changed) ?? (()=>{});
  return {start:()=>tick(),refresh:()=>tick(true),async dispose(){
    const releasing=leaseId;stopped=true;unsubscribe();clearTimer(timer);abort?.abort();await flight;
    if(releasing && available()){const controller=new AbortController(),timeout=setTimer(()=>controller.abort(),2000);try{await rpc('gpt-companion/lease',{action:'release',leaseId:releasing},controller.signal);}catch{}finally{clearTimer(timeout);}}
    clearLease();
  }};
}

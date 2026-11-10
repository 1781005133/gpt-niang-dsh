// Generated from canonical sources by scripts/build.mjs.
window.__ModuleLoader__.load({id:'dsh-gpt-companion-bridge',factory:(require)=>{
'use strict';
const module={exports:{}};const exports=module.exports;
// Browser-safe strict protocol. No filesystem, credential or network access.
const SCHEMA_VERSION = 1;
const PRODUCER = 'dsh-gpt-companion-bridge';
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_FILES = 64;
const HOST_TTL_MS = 20_000;
const QUOTA_TTL_MS = 90_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_COUNTER = 1_000_000_000_000;
const DESKTOP_PRODUCER = 'dsh-gpt-companion-desktop';
const MAX_CONTROL_BYTES = 4096;
const CONTROL_TTL_MS = 20_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 65_536;
const MAX_ARCHIVE_STATE_BYTES = 4096;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const profilePattern = /^[A-Za-z0-9_-]{1,64}$/;
const encoder = new TextEncoder();
class BridgeProtocolError extends Error { constructor(message = 'Invalid bridge data') { super(message); this.name = 'BridgeProtocolError'; } }
const fail = () => { throw new BridgeProtocolError(); };
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function keys(v, required, optional = []) { if (!record(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail(); return v; }
const integer = (v, max = MAX_COUNTER) => { if (!Number.isSafeInteger(v) || v < 0 || v > max) fail(); return v; };
const time = v => { integer(v, 253402300799000); if (v === 0) fail(); return v; };
const string = (v, max = 120) => { if (typeof v !== 'string' || encoder.encode(v).length > max || /[\x00-\x1f\x7f-\x9f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(v)) fail(); return v; };
const matches = (v, re) => { if (typeof v !== 'string' || !re.test(v)) fail(); return v; };
const boolean = v => { if (typeof v !== 'boolean') fail(); return v; };
const validateProfile = value => matches(value, profilePattern);
function nullableHash(v) { return v === null ? null : matches(v, hash); }
function bounded(value, max = MAX_SNAPSHOT_BYTES) { let text; try { text = JSON.stringify(value); } catch { fail(); } if (typeof text !== 'string' || encoder.encode(text).length > max) fail(); return value; }
const envelopeFields = ['schemaVersion','producer','instanceId','epoch','revision','lastSeenAt','expiresAt','hostActive'];
function envelope(v, extras, ttl) {
  keys(v, [...envelopeFields, ...extras]);
  if (v.schemaVersion !== SCHEMA_VERSION || v.producer !== PRODUCER) fail();
  matches(v.instanceId, uuid); matches(v.epoch, uuid); integer(v.revision, Number.MAX_SAFE_INTEGER);
  time(v.lastSeenAt); time(v.expiresAt); boolean(v.hostActive);
  if (v.expiresAt < v.lastSeenAt || v.expiresAt - v.lastSeenAt > ttl) fail();
  return Object.fromEntries(envelopeFields.map(k => [k,v[k]]));
}
function unknownQuota(errorCode = 'UNAVAILABLE', now = Date.now()) {
  return {ok:false,queryOk:false,source:'dsh',observedAt:time(now),accountKey:null,plan:null,planLabel:'未知套餐',planKnown:false,planSource:null,authType:null,windows:[],errorCode:matches(errorCode,/^[A-Z_]{1,40}$/),error:'DSH 额度暂不可用'};
}
function validateQuotaStatus(v) {
  keys(v,['ok','queryOk','source','observedAt','accountKey','plan','planLabel','planKnown','planSource','authType','windows'],['errorCode','error']);
  boolean(v.ok); boolean(v.queryOk); boolean(v.planKnown); time(v.observedAt); nullableHash(v.accountKey);
  if (v.source !== 'dsh' || !Array.isArray(v.windows) || v.windows.length > 8) fail();
  if (v.plan !== null) matches(v.plan,/^[a-z][a-z_]{0,31}$/);
  string(v.planLabel,80); if (![null,'rateLimits'].includes(v.planSource) || ![null,'oauth'].includes(v.authType)) fail();
  const windows = v.windows.map(w => {
    keys(w,['label','minutes','used','remaining','resetsAt'],['kind','total','amountUsed','amountRemaining']); string(w.label,80);
    for(const k of ['total','amountUsed','amountRemaining']) if(Object.hasOwn(w,k)) { if(w.kind!=='individual' || w[k]!==null && (typeof w[k]!=='number' || !Number.isFinite(w[k]) || w[k]<0 || w[k]>MAX_COUNTER)) fail(); }
    if(w.total!==undefined && w.total!==null && w.amountUsed!==undefined && w.amountUsed!==null && w.amountRemaining!==undefined && w.amountRemaining!==Math.max(0,w.total-w.amountUsed)) fail();
    if (w.kind !== undefined && !['individual','primary','secondary'].includes(w.kind)) fail();
    if (w.minutes !== null) { integer(w.minutes, 5256000); if (w.minutes === 0) fail(); }
    if (w.minutes === null && w.kind !== 'individual') fail();
    for (const k of ['used','remaining']) if (typeof w[k] !== 'number' || !Number.isFinite(w[k]) || w[k] < 0 || w[k] > 100) fail();
    if (Math.abs(w.used + w.remaining - 100) > 0.000001) fail();
    if (w.resetsAt !== null) { integer(w.resetsAt,253402271999); if (w.resetsAt === 0) fail(); }
    return {...w};
  });
  if (new Set(windows.map(w => `${w.kind === 'individual' ? 'individual' : w.minutes}`)).size !== windows.length) fail();
  if (v.ok && (!v.queryOk || !v.accountKey || windows.length === 0)) fail();
  if (!v.ok && (windows.length || v.accountKey !== null || v.plan !== null || v.planKnown || v.planSource !== null || v.authType !== null)) fail();
  if (v.errorCode !== undefined) matches(v.errorCode,/^[A-Z_]{1,40}$/);
  if (v.error !== undefined && !['DSH 额度暂不可用','当前账户未提供可显示的额度窗口'].includes(v.error)) fail();
  return bounded({...v,windows});
}
function validateHostSnapshot(v) {
  const base = envelope(v,['profile','connected','accountKey','numericLogs'],HOST_TTL_MS);
  validateProfile(v.profile); boolean(v.connected); nullableHash(v.accountKey);
  if (!Array.isArray(v.numericLogs) || v.numericLogs.length > MAX_LOG_FILES || !v.connected && (v.accountKey !== null || v.numericLogs.length)) fail();
  const numericLogs = v.numericLogs.map(item => { keys(item,['file','bytes','sessionKey']); matches(item.sessionKey,hash); matches(item.file,new RegExp(`^${v.epoch}-[0-9a-f]{64}\\.jsonl$`)); integer(item.bytes,MAX_LOG_BYTES); if (!item.bytes) fail(); return {...item}; });
  if (new Set(numericLogs.map(i => i.file)).size !== numericLogs.length) fail();
  return bounded({...base,profile:v.profile,connected:v.connected,accountKey:v.accountKey,numericLogs});
}
function validateQuotaSnapshot(v) {
  const base = envelope(v,['status'],QUOTA_TTL_MS); const status = validateQuotaStatus(v.status);
  if (status.observedAt > base.lastSeenAt + MAX_CLOCK_SKEW_MS || base.expiresAt > status.observedAt + QUOTA_TTL_MS) fail();
  return bounded({...base,status});
}
function validateUsage(v) {
  keys(v,['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens']);
  Object.values(v).forEach(n => integer(n)); if (v.cacheReadTokens + v.cacheWriteTokens > v.inputTokens || v.inputTokens + v.outputTokens > MAX_COUNTER) fail();
  return {...v};
}
function validateCompletionSnapshot(v) {
  const base = envelope(v,['seq','sessions','completion'],HOST_TTL_MS); integer(v.seq,Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(v.sessions) || v.sessions.length > MAX_LOG_FILES) fail();
  const sessions = v.sessions.map(s => { keys(s,['sessionKey','title','active','updatedAt','usage']); matches(s.sessionKey,hash); string(s.title,120); boolean(s.active); time(s.updatedAt); return {...s,usage:s.usage === null ? null : validateUsage(s.usage)}; });
  if (new Set(sessions.map(s => s.sessionKey)).size !== sessions.length) fail();
  let completion = null;
  if (v.completion !== null) { keys(v.completion,['seq','sessionKey','turn','completedAt']); integer(v.completion.seq,Number.MAX_SAFE_INTEGER); matches(v.completion.sessionKey,hash); integer(v.completion.turn,Number.MAX_SAFE_INTEGER); time(v.completion.completedAt); if (v.completion.seq !== v.seq || v.seq === 0) fail(); completion = {...v.completion}; }
  if ((v.seq === 0) !== (completion === null)) fail();
  return bounded({...base,seq:v.seq,sessions,completion});
}
function parseSnapshot(text, kind) {
  if (typeof text !== 'string' || encoder.encode(text).length > MAX_SNAPSHOT_BYTES) fail();
  let value; try { value = JSON.parse(text); } catch { fail(); }
  const validator = {host:validateHostSnapshot,quota:validateQuotaSnapshot,completion:validateCompletionSnapshot,'control-status':validateControlStatusSnapshot,'archive-status':validateArchiveStatusSnapshot}[kind]; if (!validator) fail(); return validator(value);
}
function isSnapshotFresh(snapshot, now = Date.now()) { return Boolean(snapshot?.hostActive === true && Number.isSafeInteger(now) && snapshot.lastSeenAt <= now + MAX_CLOCK_SKEW_MS && snapshot.expiresAt > now && snapshot.lastSeenAt <= snapshot.expiresAt); }
function snapshotsMatch(host, snapshot) { return Boolean(host && snapshot && host.schemaVersion === SCHEMA_VERSION && snapshot.schemaVersion === SCHEMA_VERSION && host.producer === PRODUCER && snapshot.producer === PRODUCER && host.instanceId === snapshot.instanceId && host.epoch === snapshot.epoch); }
function validateProjection(v) {
  keys(v,['leaseId','seq'],['status','identity','refreshResult']); matches(v.leaseId,uuid); integer(v.seq,Number.MAX_SAFE_INTEGER);
  if(!Object.hasOwn(v,'status') && !Object.hasOwn(v,'identity')) fail();
  const out={leaseId:v.leaseId,seq:v.seq};
  if(Object.hasOwn(v,'status')) out.status=validateQuotaStatus(v.status);
  if(Object.hasOwn(v,'identity')) { keys(v.identity,['accountKey','observedAt']);nullableHash(v.identity.accountKey);time(v.identity.observedAt);out.identity={...v.identity}; }
  if(Object.hasOwn(v,'refreshResult')) {
    const r=keys(v.refreshResult,['consumerInstanceId','refreshSeq','ok','observedAt','errorCode']);matches(r.consumerInstanceId,uuid);integer(r.refreshSeq,Number.MAX_SAFE_INTEGER);boolean(r.ok);
    if(r.observedAt!==null)time(r.observedAt);if(r.errorCode!==null)matches(r.errorCode,/^[A-Z_]{1,40}$/);
    if(r.ok && (r.observedAt===null || r.errorCode!==null)) fail();out.refreshResult={...r};
  }
  return bounded(out);
}
function validateDesktopControl(v) {
  keys(v,['schemaVersion','producer','instanceId','hostInstanceId','epoch','seq','issuedAt','expiresAt','active','visible','refreshSeq']);
  if(v.schemaVersion!==SCHEMA_VERSION || v.producer!==DESKTOP_PRODUCER)fail();
  matches(v.instanceId,uuid);matches(v.hostInstanceId,uuid);matches(v.epoch,uuid);integer(v.seq,Number.MAX_SAFE_INTEGER);integer(v.refreshSeq,Number.MAX_SAFE_INTEGER);time(v.issuedAt);time(v.expiresAt);boolean(v.active);boolean(v.visible);
  if(v.expiresAt<v.issuedAt || v.expiresAt-v.issuedAt>CONTROL_TTL_MS || !v.active && v.visible)fail();
  return bounded({...v},MAX_CONTROL_BYTES);
}
function parseDesktopControl(text) {
  if(typeof text!=='string' || encoder.encode(text).length>MAX_CONTROL_BYTES)fail();let value;try{value=JSON.parse(text);}catch{fail();}return validateDesktopControl(value);
}
function isDesktopControlFresh(control,host,now=Date.now()) {
  return Boolean(control && host && isSnapshotFresh(host,now) && control.hostInstanceId===host.instanceId && control.epoch===host.epoch && control.issuedAt<=now+MAX_CLOCK_SKEW_MS && control.expiresAt>now);
}
function validateControlStatusSnapshot(v) {
  const base=envelope(v,['control'],HOST_TTL_MS),c=keys(v.control,['consumerInstanceId','active','visible','refreshSeq','state','requestedAt','startedAt','completedAt','observedAt','retryAt','errorCode']);
  if(c.consumerInstanceId!==null)matches(c.consumerInstanceId,uuid);boolean(c.active);boolean(c.visible);integer(c.refreshSeq,Number.MAX_SAFE_INTEGER);
  if(!['idle','queued','running','succeeded','failed','offline','timedout','rate-limited'].includes(c.state) || c.visible && !c.active)fail();
  for(const k of ['requestedAt','startedAt','completedAt','observedAt','retryAt'])if(c[k]!==null)time(c[k]);
  if(c.errorCode!==null)matches(c.errorCode,/^[A-Z_]{1,40}$/);
  if(c.state==='succeeded' && (c.observedAt===null || c.startedAt===null || c.completedAt===null || c.observedAt<c.startedAt || c.errorCode!==null))fail();
  if(c.consumerInstanceId===null && (c.refreshSeq!==0 || c.active || c.visible || c.state!=='idle'))fail();
  return bounded({...base,control:{...c}});
}
function parseArchiveFileName(name) {
  string(name,110);const match=/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{64})\.jsonl$/.exec(name);if(!match)fail();return {originEpoch:match[1],logId:match[2]};
}
function archiveGap(v) {
  boolean(v.collectionGap);for(const k of ['firstGapAt','lastErrorAt'])if(v[k]!==null)time(v[k]);if(v.errorCode!==null)matches(v.errorCode,/^[A-Z_]{1,40}$/);
  if(v.collectionGap ? v.firstGapAt===null || v.lastErrorAt===null || v.errorCode===null : v.firstGapAt!==null || v.lastErrorAt!==null || v.errorCode!==null)fail();
}
function validateArchiveState(v) {
  keys(v,['schemaVersion','producer','accountKey','pending','collectionGap','firstGapAt','lastErrorAt','errorCode']);boolean(v.pending);if(v.schemaVersion!==SCHEMA_VERSION || v.producer!==PRODUCER)fail();matches(v.accountKey,hash);archiveGap(v);return bounded({...v},MAX_ARCHIVE_STATE_BYTES);
}
function parseArchiveState(text) {
  if(typeof text!=='string' || encoder.encode(text).length>MAX_ARCHIVE_STATE_BYTES)fail();let value;try{value=JSON.parse(text);}catch{fail();}return validateArchiveState(value);
}
function validateArchiveStatusSnapshot(v) {
  const base=envelope(v,['archive'],HOST_TTL_MS),a=keys(v.archive,['accountKey','available','initializing','pendingFiles','collectionGap','firstGapAt','lastErrorAt','errorCode','totalFiles','totalBytes']);nullableHash(a.accountKey);boolean(a.available);boolean(a.initializing);integer(a.pendingFiles,128);archiveGap(a);integer(a.totalFiles,Number.MAX_SAFE_INTEGER);integer(a.totalBytes,Number.MAX_SAFE_INTEGER);
  if(a.accountKey===null && (a.available || a.collectionGap || a.totalFiles!==0 || a.totalBytes!==0))fail();return bounded({...base,archive:{...a}});
}
function validateNumericLog(text, {epoch,sessionKey} = {}) {
  matches(epoch,uuid); matches(sessionKey,hash);
  if (typeof text !== 'string' || encoder.encode(text).length > MAX_LOG_BYTES) fail();
  const lines = text.trimEnd().split('\n'); if (!lines.length || lines.length > 512) fail();
  return lines.map((line,index) => {
    let r; try { r=JSON.parse(line); } catch { fail(); }
    keys(r,['timestamp','type','payload']); time(r.timestamp);
    const p=r.payload;
    if (r.type === 'session_meta') { if (index !== 0) fail(); keys(p,['id','session_key','origin','epoch','model_provider','source']); matches(p.session_key,hash); if (p.id !== sessionKey || p.origin !== PRODUCER || p.epoch !== epoch || !/^([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(p.model_provider) || !['dsh','subagent'].includes(p.source)) fail(); }
    else if (index === 0) fail();
    else if (r.type === 'turn_context') { keys(p,['model','model_provider','turn_id']); matches(p.model,/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/); matches(p.model_provider,/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/); matches(p.turn_id,/^\d{1,16}$/); }
    else if (r.type === 'event_msg' && p?.type === 'token_count') {
      keys(p,['type','info']); keys(p.info,['total_token_usage'],['last_token_usage']);
      for (const usage of [p.info.total_token_usage,p.info.last_token_usage].filter(x => x !== undefined)) { keys(usage,['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens','reasoning_output_tokens']); validateUsage({inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,cacheReadTokens:usage.cached_input_tokens,cacheWriteTokens:usage.cache_write_input_tokens}); if (usage.reasoning_output_tokens !== 0) fail(); }
    } else if (r.type === 'event_msg') { keys(p,['type','turn_id']); if (!['task_started','task_complete','turn_aborted'].includes(p.type)) fail(); matches(p.turn_id,/^\d{1,16}$/); }
    else fail();
    return r;
  });
}


const labels = {free:'Free',go:'Go',plus:'Plus',pro:'Pro',team:'Team',business:'Business',enterprise:'Enterprise',edu:'Edu'};
function activeAccountId(response) {
  const s=response?.ok === true ? response.value : null;
  if (s?.authenticated !== true || s.provider !== 'openai-codex' || !Array.isArray(s.accounts) || s.accounts.length > 64) return null;
  const active=s.accounts.filter(a => a?.active === true);
  return active.length === 1 && typeof active[0].id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(active[0].id) ? active[0].id : null;
}
function publicAccountIdentity(response) {
  const id=activeAccountId(response);if(!id) return null;
  const account=response.value.accounts.find(a=>a.active===true);
  const email=account.email===undefined || account.email===null ? null : account.email;
  if(email!==null && (typeof email!=='string' || email.length>320 || /[\x00-\x1f\x7f]/.test(email))) return null;
  return JSON.stringify([id,email===null ? null : email.trim().toLowerCase()]);
}
async function accountHash(identity, cryptoApi = globalThis.crypto) {
  const digest=await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(`dsh-gpt-companion:${identity}`));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
}
function normalizeDshUsage(value, accountKey, now=Date.now()) {
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
function createBridgeClient({connection,now=Date.now,cryptoApi=globalThis.crypto,setTimer=setTimeout,clearTimer=clearTimeout,intervalMs=5000,statusIntervalMs=30000,quotaIntervalMs=60000,timeoutMs=18000,onError=()=>{}}) {
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


const inject=['connection'];
function apply(ctx) {
  ctx.effect(()=>{
    const client=createBridgeClient({connection:ctx.get('connection')});
    client.start();
    return ()=>{void client.dispose();};
  },'gpt-companion: existing authenticated client projection');
}

exports.apply=apply;exports.inject=inject;return module.exports;
}});

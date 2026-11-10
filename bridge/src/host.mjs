import {randomUUID} from 'node:crypto';
import {PRODUCER, SCHEMA_VERSION, HOST_TTL_MS, QUOTA_TTL_MS, MAX_CLOCK_SKEW_MS, MAX_LOG_FILES, validateHostSnapshot, validateQuotaSnapshot, validateCompletionSnapshot, validateProjection, validateControlStatusSnapshot, validateArchiveStatusSnapshot, unknownQuota} from '../../shared/bridge-protocol.mjs';
import {createSnapshotFiles,resolveBridgeRoot} from './filesystem.mjs';
import {hashId,officialUsage,safeTitle,UsageAccounting} from './usage-accounting.mjs';
import {ConsumerControls} from './controls.mjs';
import {NumericArchive} from './archive.mjs';
export function createBridgeHost({dshHome,profile,env,home,now=Date.now,createId=randomUUID,files,setRepeater=setInterval,clearRepeater=clearInterval,readProjection=()=>null,listSessions=()=>[],onWarning=()=>{},archive,archiveOptions={}}={}) {
  const location=resolveBridgeRoot({dshHome,profile,env,home});
  files ??= createSnapshotFiles(location.root);
  const instanceId=createId(); let epoch=createId(),revision=0,active=true,lease=null,accountKey=null,quota=unknownQuota('NO_CLIENT',now()),completion=null,seq=0;
  const sessions=new Map(); let logFiles=new Map(),identityAt=0;
  const controls=new ConsumerControls({read:()=>files.readControl?.() ?? null,now});
  const archiveStore=archive ?? new NumericArchive({...archiveOptions,root:location.root,now});
  files.clearLogs();
  const connected=()=>active && Boolean(lease && lease.expiresAt>now() && accountKey);
  const base=(ttl=HOST_TTL_MS,at=now())=>({schemaVersion:SCHEMA_VERSION,producer:PRODUCER,instanceId,epoch,revision,lastSeenAt:at,expiresAt:at+ttl,hostActive:active});
  function publish() {
    const at=now(); revision++;
    const completionValue=validateCompletionSnapshot({...base(HOST_TTL_MS,at),seq,sessions:[...sessions.values()].map(s=>({sessionKey:s.key,title:s.title,active:s.running !== null,updatedAt:s.updatedAt,usage:s.accounting.usage()})),completion});
    const expires=Math.min(at+QUOTA_TTL_MS,quota.observedAt+QUOTA_TTL_MS);
    // An expired source observation is unknown, even if host heartbeat is live.
    if(expires<=at) quota=unknownQuota('STALE_QUOTA',at);
    const quotaValue=validateQuotaSnapshot({...base(QUOTA_TTL_MS,at),expiresAt:Math.min(at+QUOTA_TTL_MS,quota.observedAt+QUOTA_TTL_MS),status:quota});
    files.write('quota.json',quotaValue); files.write('completion.json',completionValue);
    const control=controls.update(base(HOST_TTL_MS,at),Boolean(active && lease && lease.expiresAt>at));
    files.write('control-status.json',validateControlStatusSnapshot({...base(HOST_TTL_MS,at),control}));
    files.write('archive-status.json',validateArchiveStatusSnapshot({...base(HOST_TTL_MS,at),archive:archiveStore.status(accountKey)}));
    files.write('host.json',validateHostSnapshot({...base(HOST_TTL_MS,at),profile:location.profile,connected:connected(),accountKey,numericLogs:[...logFiles.values()].map(({file,bytes,sessionKey})=>({file,bytes,sessionKey}))}));
  }
  function clear(code='UNAVAILABLE') {
    // Invalidate the host first. Readers cannot reuse an old account while disk cleanup runs.
    accountKey=null; identityAt=0; quota=unknownQuota(code,now()); epoch=createId(); sessions.clear(); seq=0; completion=null; logFiles.clear();
    publish(); files.clearLogs();
  }
  function expire() {
    if(lease && lease.expiresAt<=now()) {controls.offline(lease.id);lease=null;clear('CLIENT_EXPIRED');}
    else if(accountKey && now()-identityAt>=QUOTA_TTL_MS) clear('IDENTITY_EXPIRED');
  }
  const reject=code=>({ok:false,error:{code,message:'Bridge request refused',details:{issues:[]}}});
  function acquire() {
    if(!active) return reject('disposed'); expire();
    if(lease) return reject('lease-in-use');
    clear('CONNECTING'); lease={id:createId(),seq:-1,expiresAt:now()+QUOTA_TTL_MS}; publish();
    return {ok:true,value:{leaseId:lease.id,instanceId,expiresAt:lease.expiresAt}};
  }
  function release(id) {
    if(!active || !lease || lease.id!==id) return reject('lease-invalid');
    controls.offline(lease.id);lease=null;clear('CLIENT_DISCONNECTED');return {ok:true,value:{}};
  }
  function control(value) {
    if(!active)return reject('disposed');expire();
    if(!value || typeof value!=='object' || Object.keys(value).some(k=>!['leaseId','claimRefresh'].includes(k)) || !lease || value.leaseId!==lease.id)return reject('lease-invalid');
    controls.update(base(),true);let granted=false;
    if(value.claimRefresh!==undefined) {
      const c=value.claimRefresh;if(!c || typeof c!=='object' || Object.keys(c).length!==2 || typeof c.consumerInstanceId!=='string' || !Number.isSafeInteger(c.refreshSeq) || c.refreshSeq<0)return reject('invalid-input');
      granted=controls.claim({leaseId:lease.id,consumerInstanceId:c.consumerInstanceId,refreshSeq:c.refreshSeq});
    }
    publish();return {ok:true,value:{...controls.status(),...(granted?{consumerInstanceId:value.claimRefresh.consumerInstanceId,refreshSeq:value.claimRefresh.refreshSeq}:{}),granted}};
  }
  function project(value) {
    if(!active) return reject('disposed'); expire();
    let input; try { input=validateProjection(value); } catch { if(lease && value?.leaseId===lease.id) clear('INVALID_PROJECTION'); return reject('invalid-input'); }
    if(!lease || input.leaseId!==lease.id || input.seq<=lease.seq) return reject('lease-invalid');
    lease.seq=input.seq; lease.expiresAt=now()+QUOTA_TTL_MS;
    const identity=input.identity ?? {accountKey:input.status.ok?input.status.accountKey:null,observedAt:now()};
    if(identity.observedAt>now()+MAX_CLOCK_SKEW_MS || now()-identity.observedAt>=QUOTA_TTL_MS){clear('IDENTITY_EXPIRED');return reject('stale-identity');}
    if(input.status?.ok && input.status.accountKey!==identity.accountKey){clear('ACCOUNT_CHANGED');return reject('identity-mismatch');}
    if(input.status && (input.status.observedAt>now()+MAX_CLOCK_SKEW_MS || now()-input.status.observedAt>=QUOTA_TTL_MS)) {
      if(!input.identity){clear('STALE_QUOTA');return reject('stale-input');}input.status=unknownQuota('STALE_QUOTA',now());
    }
    if(!identity.accountKey) {
      if(accountKey || sessions.size)clear(input.status?.errorCode ?? 'NO_ACCOUNT');
      quota=input.status ?? unknownQuota('NO_ACCOUNT',now());
    } else {
      const accountChanged=accountKey!==identity.accountKey;if(accountChanged)clear('ACCOUNT_CHANGED');
      accountKey=identity.accountKey;identityAt=identity.observedAt;if(input.status)quota=input.status;
      if(accountChanged) {
        try{let count=0;for(const session of listSessions()){if(count++>=MAX_LOG_FILES){archiveStore.markGap(accountKey,'SESSION_CAPACITY');break;}getSession(session);}}
        catch{onWarning('Session baseline unavailable');}
      }
    }
    controls.complete(input.refreshResult,input.status,identity,lease.id);
    publish();return {ok:true,value:{epoch}};
  }
  function snapshot(session) { try { return readProjection(session)?.values ?? null; } catch { return null; } }
  function getSession(session) {
    if(!connected() || typeof session?.id!=='string' || session.id.length>512 || session.header?.version!==4) return null;
    const key=hashId(session.id); let state=sessions.get(key);
    if(!state) {
      if(sessions.size>=MAX_LOG_FILES) {
        const oldest=[...sessions.values()].find(s=>s.running===null);if(!oldest){archiveStore.markGap(accountKey,'SESSION_CAPACITY');return null;}
        removeSession(oldest.key);
      }
      const values=snapshot(session), at=now();
      state={key,title:safeTitle(values?.title?.title),updatedAt:at,running:null,lastEvent:-1,main:session.header.origin!=='subagent' && !session.header.parentSession && !(session.header.delegationDepth>0),accounting:new UsageAccounting({sessionKey:key,source:session.header.origin==='subagent' ? 'subagent' : 'dsh',baseline:officialUsage(values?.tokenUsage),at})};
      state.archivedRoutes=new Map();sessions.set(key,state);
      if(state.accounting.usage()===null)archiveStore.markGap(accountKey,'PROJECTION_UNAVAILABLE');
    }
    return state;
  }
  function removeSession(key) {
    sessions.delete(key);
    for(const [file,item] of logFiles) if(item.sessionKey===key) { files.removeLog(file); logFiles.delete(file); }
  }
  function exportLogs(state) {
    let logs;
    try { logs=state.accounting.logs(epoch); }
    catch { logs=[];state.accounting.valid=false;onWarning('Numeric projection unavailable'); }
    const canonicalNames=new Set(logs.map(log=>log.file)),segmentId=state.accounting.segmentId;
    if(!state.accounting.valid || state.accounting.usage()===null)archiveStore.markGap(accountKey,'PROJECTION_UNAVAILABLE');
    for(const [file,prior]of state.archivedRoutes)if(!canonicalNames.has(file)) {
      // Same-segment model correction removes prior attribution. A metadata-only
      // canonical tombstone lets durable consumers transactionally retract it.
      if(state.accounting.valid && prior.segmentId===segmentId){if(archiveStore.write(accountKey,file,prior.empty))state.archivedRoutes.delete(file);}
      else if(prior.segmentId!==segmentId)state.archivedRoutes.delete(file); // rotation retains the completed archive
    }
    for(const log of logs){archiveStore.write(accountKey,log.file,log.text);state.archivedRoutes.set(log.file,{segmentId,empty:log.text.slice(0,log.text.indexOf('\n')+1)});}
    const previousCount=[...logFiles.values()].filter(item=>item.sessionKey===state.key).length;
    const activeLogs=logs.slice(0,Math.max(0,MAX_LOG_FILES-(logFiles.size-previousCount))),nextNames=new Set(activeLogs.map(log=>log.file));
    for(const [file,item]of logFiles)if(item.sessionKey===state.key && !nextNames.has(file)){files.removeLog(file);logFiles.delete(file);}
    for(const log of activeLogs){const bytes=files.write(log.file,log.text,true);logFiles.set(log.file,{file:log.file,bytes,sessionKey:state.key});}
  }
  function created(session) { expire(); const state=getSession(session); if(state) publish(); }
  function changed(session,key) {
    if(key!=='title') return;
    expire(); const state=getSession(session); if(!state) return;
    state.title=safeTitle(snapshot(session)?.title?.title); state.updatedAt=now(); publish();
  }
  function event(session,event) {
    expire();
    if(!['turn/start','turn/end','assistant/message','assistant/attempt','llm/retry-started','session/title'].includes(event?.type)) return;
    if(!Number.isSafeInteger(event.seq) || event.seq<(session?.firstLiveSeq ?? 0) || !Number.isSafeInteger(event.time) || event.time<=0 || event.time>now()+MAX_CLOCK_SKEW_MS) return;
    const state=getSession(session); if(!state || event.seq<=state.lastEvent) return;
    state.lastEvent=event.seq; state.updatedAt=event.time;
    const values=snapshot(session); state.title=safeTitle(values?.title?.title);
    if(event.type==='turn/start' && Number.isSafeInteger(event.data?.turn) && event.data.turn>=0) state.running=event.data.turn;
    if(['assistant/message','assistant/attempt','llm/retry-started'].includes(event.type)) { state.accounting.settle(event,officialUsage(values?.tokenUsage)); exportLogs(state); }
    if(event.type==='turn/end') {
      if(state.main && state.running===event.data?.turn && event.data?.reason?.kind==='completed') completion={seq:++seq,sessionKey:state.key,turn:event.data.turn,completedAt:event.time};
      state.running=null;
    }
    publish();
  }
  function disposed(session) { expire(); const state=sessions.get(hashId(String(session?.id))); if(state) { state.running=null; state.updatedAt=now(); publish(); } }
  publish();
  const timer=setRepeater(()=>{ if(!active) return; try { expire(); publish(); } catch { onWarning('Bridge heartbeat unavailable'); } },5000); timer?.unref?.();
  return {root:location.root,archive:archiveStore,acquire,release,control,project,created,changed,event,disposed,
    heartbeat(){expire();publish();},
    invalidate:clear,
    dispose(){if(!active)return;clearRepeater(timer);archiveStore.dispose();active=false;lease=null;clear('HOST_DISCONNECTED');},
  };
}

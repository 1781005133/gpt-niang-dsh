import {MAX_SNAPSHOT_BYTES} from './bridge-protocol.mjs';
export function isLocalRequest(request) {
  try {
    const target=new URL(request.url),rawHost=request.headers.get('host'),rawOrigin=request.headers.get('origin');
    if(!['http:','https:'].includes(target.protocol) || request.headers.get('sec-fetch-site')?.toLowerCase()==='cross-site')return false;
    const authority=rawHost ?? target.host,parts=/^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?$/i.exec(authority);
    if(!parts || parts[2] && Number(parts[2])>65535)return false;
    if(rawOrigin===null){
      // The owned desktop shell strips Origin before authenticated forwarding.
      // Missing Origin is allowed ONLY here, behind Connection's owner admission,
      // with an actual strict loopback Host. This check never authenticates callers.
      if(rawHost===null)return false;
      return target.hostname==='dsh.internal' || new URL(`${target.protocol}//${authority}`).host===target.host;
    }
    const origin=new URL(rawOrigin);
    if(rawOrigin!==origin.origin || !['http:','https:'].includes(origin.protocol) || origin.username || origin.password || !['localhost','127.0.0.1','[::1]'].includes(origin.hostname))return false;
    if(new URL(`${origin.protocol}//${authority}`).host!==origin.host)return false;
    return target.hostname==='dsh.internal' || target.origin===origin.origin;
  } catch { return false; }
}
async function readBoundedJson(request) {
  if(request.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json') throw Error('Invalid content type');
  const length=request.headers.get('content-length'); if(length && (!/^\d+$/.test(length) || Number(length)>MAX_SNAPSHOT_BYTES+1024)) throw Error('Too large');
  const reader=request.body?.getReader(); if(!reader) throw Error('No body');
  const chunks=[]; let total=0;
  try {
    while(true) { request.signal.throwIfAborted(); const {done,value}=await reader.read(); if(done) break; total+=value.byteLength; if(total>MAX_SNAPSHOT_BYTES+1024) throw Error('Too large'); chunks.push(value); }
    const data=new Uint8Array(total); let offset=0; for(const c of chunks) { data.set(c,offset); offset+=c.byteLength; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
// Registration stays behind DSH Connection's admitted owner Peer boundary.
export function registerBridgeTransport(connection,host,clientRequestSchema) {
  const disposers=[];
  try {
    for(const endpoint of ['lease','projection','control']) {
      const method=`gpt-companion/${endpoint}`;
      disposers.push(connection.fetch.register({path:`/api/${method}`,methods:['POST'],requestBody:'streaming',
        async fetch(request) {
          if(!isLocalRequest(request)) return new Response('Local bridge only',{status:403});
          let parsed;
          try { const result=clientRequestSchema.safeParse(await readBoundedJson(request)); if(!result.success || result.data.method!==method) throw Error('Invalid envelope'); parsed=result.data; }
          catch { return new Response('Invalid bridge request',{status:400}); }
          let result;
          try {
            request.signal.throwIfAborted();
            if(endpoint==='projection') result=host.project(parsed.payload);
            else if(endpoint==='control')result=host.control(parsed.payload);
            else {
              const p=parsed.payload;
              if(p?.action==='acquire' && Object.keys(p).length===1) result=host.acquire();
              else if(p?.action==='release' && Object.keys(p).length===2 && typeof p.leaseId==='string') result=host.release(p.leaseId);
              else return new Response('Invalid bridge lease',{status:400});
            }
          } catch { result={ok:false,error:{code:'unavailable',message:'Bridge unavailable',details:{issues:[]}}}; }
          return Response.json({type:'server-response',rpcId:parsed.rpcId,result});
        }
      }));
    }
  } catch(error) { for(const dispose of disposers.reverse()) dispose(); throw error; }
  return ()=>{for(const dispose of disposers.reverse()) dispose();};
}

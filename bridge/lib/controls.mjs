import {isDesktopControlFresh,MAX_CLOCK_SKEW_MS} from './bridge-protocol.mjs';
const blank=()=>({consumerInstanceId:null,active:false,visible:false,refreshSeq:0,state:'idle',requestedAt:null,startedAt:null,completedAt:null,observedAt:null,retryAt:null,errorCode:null});
export class ConsumerControls {
  constructor({read=()=>null,now=Date.now,minForceMs=10000,claimTimeoutMs=30000}={}) {this.read=read;this.now=now;this.minForceMs=minForceMs;this.claimTimeoutMs=claimTimeoutMs;this.books=new Map();this.owner=null;this.frame=null;this.ack=blank();this.running=null;this.lastForce=-Infinity;}
  update(host,clientAlive) {
    const now=this.now();let next=null;
    try {const candidate=this.read();if(candidate && isDesktopControlFresh(candidate,host,now))next=candidate;} catch {}
    let accepted=false;
    if(next && (!this.owner || this.owner.instanceId===next.instanceId || !this.owner.active || this.owner.expiresAt<=now)) {
      const prior=this.books.get(next.instanceId),serialized=JSON.stringify(next);
      if(!prior || next.seq>prior.seq && next.refreshSeq>=prior.refreshSeq || next.seq===prior.seq && serialized===prior.serialized) {
        const book=prior ?? {seq:-1,refreshSeq:0,consumed:0};Object.assign(book,{seq:next.seq,refreshSeq:next.refreshSeq,serialized});this.books.set(next.instanceId,book);
        while(this.books.size>32) {const oldest=this.books.keys().next().value;if(oldest===next.instanceId)break;this.books.delete(oldest);}
        this.owner=next;this.frame=next;accepted=true;
        if(this.ack.consumerInstanceId!==next.instanceId || next.refreshSeq>this.ack.refreshSeq) this.ack={...blank(),consumerInstanceId:next.instanceId,refreshSeq:next.refreshSeq,state:next.refreshSeq>book.consumed?'queued':'idle',requestedAt:next.refreshSeq>book.consumed?next.issuedAt:null};
      }
    }
    if(!accepted)this.frame=null;
    if(this.running && this.running.deadline<=now) {this.finish('timedout','TIMED_OUT',null);this.running=null;}
    const visible=Boolean(this.frame?.active && this.frame?.visible),active=Boolean(this.frame?.active);
    const outstanding=this.ack.consumerInstanceId!==null && this.ack.refreshSeq>(this.books.get(this.ack.consumerInstanceId)?.consumed ?? 0);
    if(outstanding) {
      if(!active) {this.ack.state='failed';this.ack.errorCode='CONTROL_EXPIRED';this.ack.completedAt=now;this.books.get(this.ack.consumerInstanceId).consumed=this.ack.refreshSeq;}
      else if(!clientAlive) {this.ack.state='offline';this.ack.errorCode='OFFLINE';}
      else if(!this.running) {this.ack.state=visible && now<this.lastForce+this.minForceMs?'rate-limited':'queued';this.ack.retryAt=this.ack.state==='rate-limited'?this.lastForce+this.minForceMs:null;this.ack.errorCode=null;}
    }
    return this.snapshot();
  }
  pending() {return Boolean(this.frame && this.frame.refreshSeq>(this.books.get(this.frame.instanceId)?.consumed ?? 0));}
  snapshot() {return {...this.ack,active:Boolean(this.frame?.active),visible:Boolean(this.frame?.active && this.frame?.visible)};}
  status() {return {visible:Boolean(this.frame?.active && this.frame?.visible),consumerInstanceId:this.frame?.instanceId ?? null,refreshSeq:this.frame?.refreshSeq ?? 0,pending:this.pending(),retryAt:this.ack.retryAt,granted:false};}
  claim({leaseId,consumerInstanceId,refreshSeq}) {
    if(!this.frame?.active || !this.frame.visible || this.frame.instanceId!==consumerInstanceId || this.frame.refreshSeq!==refreshSeq || !this.pending() || this.running)return false;
    const now=this.now();if(now<this.lastForce+this.minForceMs){this.ack.state='rate-limited';this.ack.retryAt=this.lastForce+this.minForceMs;return false;}
    this.lastForce=now;this.books.get(consumerInstanceId).consumed=refreshSeq;
    this.running={consumerInstanceId,refreshSeq,leaseId,startedAt:now,deadline:now+this.claimTimeoutMs};
    Object.assign(this.ack,{state:'running',startedAt:now,completedAt:null,observedAt:null,retryAt:null,errorCode:null});return true;
  }
  finish(state,errorCode,observedAt) {
    if(this.running && this.ack.consumerInstanceId===this.running.consumerInstanceId && this.ack.refreshSeq===this.running.refreshSeq)Object.assign(this.ack,{state,errorCode,startedAt:this.running.startedAt,completedAt:this.now(),observedAt,retryAt:null});
  }
  complete(result,status,identity,leaseId) {
    const running=this.running;if(!result || !running || running.leaseId!==leaseId || running.consumerInstanceId!==result.consumerInstanceId || running.refreshSeq!==result.refreshSeq)return false;
    const success=result.ok && status?.ok===true && identity?.accountKey===status.accountKey && result.observedAt===status.observedAt && status.observedAt>=running.startedAt && status.observedAt<=this.now()+MAX_CLOCK_SKEW_MS;
    this.finish(success?'succeeded':'failed',success?null:result.ok?'STALE_RESULT':result.errorCode ?? 'QUERY_FAILED',success?status.observedAt:null);this.running=null;return true;
  }
  offline(leaseId) {if(this.running?.leaseId===leaseId){this.finish('offline','OFFLINE',null);this.running=null;}}
}

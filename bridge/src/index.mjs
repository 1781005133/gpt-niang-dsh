import {clientRequestSchema} from '@deepseek-ai/dsh-client-connection';
import {createBridgeHost} from './host.mjs';
import {registerBridgeTransport} from './transport.mjs';
export const name='gpt-companion-bridge';
export const inject=[];
export function apply(ctx) {
  ctx.inject(['connection'],scope=>scope.effect(()=>{
    const warn=()=>scope.logger?.warn?.('GPT companion bridge unavailable (no private details logged)');
    const host=createBridgeHost({readProjection:session=>scope.get('sessionProjections')?.snapshot(session,['tokenUsage','title','sessionStats']),listSessions:()=>scope.get('sessions')?.list?.() ?? [],onWarning:warn});
    const disposers=[];
    const safe=fn=>(...args)=>{try{fn(...args);}catch{warn();try{host.invalidate('PROJECTION_FAILED');}catch{}}};
    try {
      disposers.push(registerBridgeTransport(scope.connection,host,clientRequestSchema));
      disposers.push(scope.on('session/created',safe(host.created)));
      disposers.push(scope.on('session/event',safe(host.event)));
      disposers.push(scope.on('session/disposed',safe(host.disposed)));
      const projections=scope.get('sessionProjections');
      if(projections?.onChanged) disposers.push(projections.onChanged(safe(host.changed)));
    } catch(error) { for(const dispose of disposers.reverse())dispose();host.dispose();throw error; }
    return ()=>{for(const dispose of disposers.reverse())dispose();host.dispose();};
  },'gpt-companion: authenticated local filesystem projection'));
}

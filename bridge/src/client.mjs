import {createBridgeClient} from './client-core.mjs';
export const inject=['connection'];
export function apply(ctx) {
  ctx.effect(()=>{
    const client=createBridgeClient({connection:ctx.get('connection')});
    client.start();
    return ()=>{void client.dispose();};
  },'gpt-companion: existing authenticated client projection');
}

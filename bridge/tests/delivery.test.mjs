import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {bridgeRoot,fixture} from './helpers.mjs';
await import('../scripts/build.mjs');
test('standard browser loader entry exports apply/inject and has no Node transport or credential imports',()=>{
  const file=path.join(bridgeRoot,'lib/client.js'),source=fs.readFileSync(file,'utf8');let registration;
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:r=>{registration=r;}}},TextEncoder,TextDecoder,AbortController,crypto:globalThis.crypto,setTimeout,clearTimeout,URL});
  assert.equal(registration.id,'dsh-gpt-companion-bridge');const entry=registration.factory(()=>{throw Error('No runtime require expected');});assert.equal(typeof entry.apply,'function');assert.deepEqual(Array.from(entry.inject),['connection']);
  assert.ok(!/\b(?:import|require)\s*\(\s*['"]node:/.test(source));assert.ok(!source.includes('document.cookie'));assert.ok(!source.includes('fetch('));assert.ok(!source.includes('createPeer'));
  let effect;entry.apply({effect:fn=>{effect=fn;},get:()=>({isLoopback:false,generation:{getSnapshot:()=>null,subscribe:()=>()=>{}}})});const dispose=effect();assert.equal(typeof dispose,'function');dispose();
});
test('release files are self-contained, include canonical contract and expose standard package metadata',async()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(bridgeRoot,'package.json'),'utf8'));
  assert.equal(manifest.name,'dsh-gpt-companion-bridge');assert.equal(manifest.version,'0.1.0-beta.1');assert.equal(manifest.dsh.client.platform,'web');assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-client-connection'].optional,true);assert.equal(manifest.engines.node,'^22.19.0 || >=24.0.0');
  if(process.env.DSH_BRIDGE_TEST_SDK_ROOT) { const sdk=JSON.parse(fs.readFileSync(path.join(process.env.DSH_BRIDGE_TEST_SDK_ROOT,'node_modules/@deepseek-ai/dsh-client-connection/package.json'),'utf8'));assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-client-connection'],sdk.version); }
  for(const target of Object.values(manifest.exports)) assert.ok(fs.statSync(path.join(bridgeRoot,target)).isFile());
  for(const name of ['index','host','filesystem','usage-accounting','transport','client-core']) {const text=fs.readFileSync(path.join(bridgeRoot,'lib',`${name}.mjs`),'utf8');assert.ok(!text.includes('../../shared/'));}
  assert.equal(fs.readFileSync(path.join(bridgeRoot,'lib/bridge-protocol.mjs'),'utf8'),fs.readFileSync(path.join(bridgeRoot,'../shared/bridge-protocol.mjs'),'utf8'));
  const host=await import('../lib/host.mjs');assert.equal(typeof host.createBridgeHost,'function');
});
test('built host entry resolves with the real SDK peer and stages lifecycle without starting DSH',{skip:!process.env.DSH_BRIDGE_TEST_SDK_ROOT},async t=>{
  const dir=fixture(t);fs.cpSync(path.join(bridgeRoot,'lib'),path.join(dir,'lib'),{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');
  const namespace=path.join(dir,'node_modules','@deepseek-ai');fs.mkdirSync(namespace,{recursive:true});
  fs.symlinkSync(path.join(process.env.DSH_BRIDGE_TEST_SDK_ROOT,'node_modules/@deepseek-ai/dsh-client-connection'),path.join(namespace,'dsh-client-connection'),'junction');
  const entry=await import(pathToFileURL(path.join(dir,'lib/index.mjs')).href);assert.equal(entry.name,'gpt-companion-bridge');let injected;
  entry.apply({inject:(deps,callback)=>{injected={deps,callback};}});assert.deepEqual(injected.deps,['connection']);assert.equal(typeof injected.callback,'function');
  // Deliberately do not execute the effect: it would be deployment, not an isolated import test.
});

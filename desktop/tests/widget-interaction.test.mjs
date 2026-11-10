import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {guiEnvironment} from '../src/core/storage.mjs';
test('renderer keeps geometry lightweight and pointer cancellation does not trigger clicks',{skip:process.platform!=='win32',timeout:25000},async()=>{
  const child=spawn(fileURLToPath(new URL('../node_modules/electron/dist/electron.exe',import.meta.url)),[fileURLToPath(new URL('./fixtures/widget-interaction-electron.mjs',import.meta.url))],{windowsHide:true,env:guiEnvironment(),stdio:'pipe'});
  let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);
  assert.equal(await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);}),0,error);
  const result=JSON.parse(output.trim().split(/\r?\n/).find(line=>line.startsWith('{')));
  assert.equal(result.geometry.rowRebuilds,0,JSON.stringify(result));assert.equal(result.geometry.audioKeyBuilds,0);assert.equal(result.geometry.sameRow,true);
  assert.deepEqual(result.quota,{text:true,width:'39%',sameRow:true});
  assert.deepEqual(result.audio,{decodeCalls:2,press:true,release:true});
  assert.deepEqual(result.pointer,{foreign:['arm','end'],cancel:['arm','cancel'],blur:['arm','cancel'],outside:[],pose:['arm','end']});
  assert.deepEqual(result.audioSwitch,{whileLoading:0,afterLoading:1});
  assert.deepEqual(result.music,{started:true,width:52,height:208,dragWithoutAudio:true,errors:[]},JSON.stringify(result));
  assert.deepEqual(result.replacement,{sameIdReloaded:true,resourcesUpdated:true});
  assert.equal(result.quoteLayout.matching,true);assert.equal(result.quoteLayout.cases,3);assert.ok(result.quoteLayout.actualCalls<result.quoteLayout.referenceCalls);
  assert.equal(result.quoteLayout.quotaTooltip,true);assert.equal(result.quoteLayout.colorReset,true);
  // Native titles are painted by Windows and cannot be dismissed while the
  // pointer rests, so the widget draws its own tip and never sets a title.
  assert.deepEqual(result.tooltipLifetime.collapsed,{bubble:false,header:false,rows:false},JSON.stringify(result.tooltipLifetime));
  assert.deepEqual(result.tooltipLifetime.restored,{bubble:true,header:true,rows:true},JSON.stringify(result.tooltipLifetime));
  // Hovering the bubble shows the widget's own tip; moving away removes it at
  // once, which a Windows-painted native tip cannot do.
  assert.equal(result.tooltipHover.shown,true,JSON.stringify(result.tooltipHover));
  assert.equal(result.tooltipHover.nonEmpty,true,JSON.stringify(result.tooltipHover));
  assert.equal(result.tooltipHover.inWindow,true,JSON.stringify(result.tooltipHover));
  // Mounted on <body>, not inside the scale-transformed #stage that clipped it.
  assert.equal(result.tooltipHover.insideBody,true,JSON.stringify(result.tooltipHover));
  assert.equal(result.tooltipHover.goneAfterMove,true,JSON.stringify(result.tooltipHover));
  assert.equal(result.tooltipHover.backAgain,true,JSON.stringify(result.tooltipHover));
  assert.equal(result.tooltipHover.goneAfterLeave,true,JSON.stringify(result.tooltipHover));
  // A quote bubble already shows its sentence; repeating it as a tip truncated
  // into the half-rendered duplicate that prompted this fix.
  assert.equal(result.quoteModeTooltip,false,'quote mode must not raise a tooltip');
});

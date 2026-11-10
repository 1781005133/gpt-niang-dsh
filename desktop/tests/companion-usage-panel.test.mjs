import test from 'node:test';import assert from 'node:assert/strict';
import {usageSourceInfo,usageCardRows,buildUsage} from '../ui/usage-panel.mjs';
test('DSH source label and history warnings remain visible without becoming a request failure',()=>{
 const info=usageSourceInfo({usage:{source:'dsh',snapshot:{sourceLabel:'启用桥接后已观测记录（DSH数值档案）',error:'正在补读',history:{pending:true,gap:true,message:'存在已标记的观测缺口'}}}});
 assert.equal(info.heading,'DSH 数值档案');assert.match(info.location,/已观测记录/);assert.deepEqual(info.warnings,['正在补读','存在已标记的观测缺口']);assert.match(info.hint,/不代表平台账单/);
});
test('Codex directory choice, location and hints retain their original meaning',()=>{
 const info=usageSourceInfo({settings:{hostSource:'codex'},usage:{source:'codex',snapshot:{home:'D:\\Codex logs'}}});
 assert.equal(info.dsh,false);assert.equal(info.heading,'Codex 数据目录');assert.equal(info.location,'D:\\Codex logs');assert.match(info.hint,/仅读取所选目录/);assert.deepEqual(info.warnings,[]);
});
test('source before first response follows saved host source, never mislabels missing DSH as Codex',()=>{
 const info=usageSourceInfo({settings:{hostSource:'dsh'},usage:{error:'桥接离线'}});
 assert.equal(info.dsh,true);assert.match(info.waiting,/DSH/);assert.equal(info.location,'等待已验证的 DSH 桥接');assert.deepEqual(info.warnings,['桥接离线']);
});
test('identical warnings appear once and malformed optional warnings are ignored',()=>{
 const info=usageSourceInfo({usage:{source:'dsh',error:'历史同步中',snapshot:{error:'历史同步中',history:{message:42}}}});
 assert.deepEqual(info.warnings,['历史同步中']);
});
test('recent-round card consumes verified turnCost but keeps legacy Codex missing cost absent',()=>{
 const recent={input:121,output:0},cost={amounts:[{currency:'USD',amount:'0.000242'}]};
 assert.equal(usageCardRows({selected:{turnUsage:recent,turnCost:cost}})[1][2],cost);
 const legacy=usageCardRows({selected:{turnUsage:recent}})[1];assert.equal(legacy[1],recent);assert.equal(legacy[2],null);
 assert.deepEqual(usageCardRows({}).map(row=>row[0]),['所选对话累计','所选对话最近一轮','今日已记录','账本累计']);
});
test('no-snapshot panel emits DSH heading and explicit optional Codex directory buttons',()=>{
 const nodes=[],buttons=[];const el=(tag,text,parent)=>{const node={tag,text,parent,className:''};nodes.push(node);return node;};
 buildUsage({el,button:(label,action)=>buttons.push({label,action}),command:()=>{}},{settings:{hostSource:'dsh'},usage:{source:'dsh',error:'桥接离线'}});
 assert(nodes.some(n=>n.tag==='strong'&&n.text==='DSH 数值档案'));
 assert(nodes.some(n=>n.text==='桥接离线'&&n.className==='usage-warning'));
 assert.deepEqual(buttons.map(b=>b.action),['usage-folder','usage-home-auto']);
 assert(buttons.every(b=>b.label.includes('Codex')));assert(!nodes.some(n=>n.text==='Codex 数据目录'));
});

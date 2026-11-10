import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../desktop');
function patch(name,pairs){const file=path.join(root,name);let s=fs.readFileSync(file,'utf8');for(const [a,b]of pairs){if(!s.includes(a))throw Error('Expected '+name+': '+a.slice(0,70));s=s.replace(a,b);}fs.writeFileSync(file,s);}
patch('src/core/update-network.mjs',[
 ['export const RELEASE_API =\n  "https://api.github.com/repos/T7moris/GPT-Niang/releases/latest";\nconst RELEASE_PATH = "/T7moris/GPT-Niang/releases/download/";',`// No public feed exists for this independent fork yet. A build maintainer may\n// explicitly supply its own repository; upstream GPT-Niang is never trusted.\nexport function createUpdatePolicy(repository) {\n  if (typeof repository!=="string" || !/^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(repository) || repository.toLowerCase()==="t7moris/gpt-niang") throw Error("Invalid independent update repository");\n  return Object.freeze({repository,api:"https://api.github.com/repos/"+repository+"/releases/latest",releasePath:"/"+repository+"/releases/download/"});\n}\nexport const DEFAULT_UPDATE_POLICY=Object.freeze({repository:null,api:null,releasePath:null});\nexport const RELEASE_API=DEFAULT_UPDATE_POLICY.api;`],
 ['export function allowedUrl(value, { api = false } = {}) {','export function allowedUrl(value, { api = false, policy = DEFAULT_UPDATE_POLICY } = {}) {\n  if(!policy.repository || !policy.api || !policy.releasePath)throw Error("独立版尚未配置在线发行源，请使用已校验的独立版安装包手动升级。");'],
 ['? value === RELEASE_API','? value === policy.api'],
 ['url.pathname.startsWith(RELEASE_PATH)','url.pathname.startsWith(policy.releasePath)'],
 ['    redirects = 0,','    redirects = 0,\n    policy = DEFAULT_UPDATE_POLICY,'],
 ['  allowedUrl(url, { api });','  allowedUrl(url, { api, policy });'],
 ['              redirects: redirects + 1,','              redirects: redirects + 1,\n              policy,'],
 ['export function selectRelease(release, currentVersion) {','export function selectRelease(release, currentVersion, {policy=DEFAULT_UPDATE_POLICY}={}) {'],
 ['    allowedUrl(asset.browser_download_url);','    allowedUrl(asset.browser_download_url,{policy});'],
 ['      RELEASE_PATH +','      policy.releasePath +']
]);
patch('src/core/updater.mjs',[
 ['  RELEASE_API,','  DEFAULT_UPDATE_POLICY,'],
 ['    isIdle = () => true,','    isIdle = () => true,\n    releasePolicy = DEFAULT_UPDATE_POLICY,'],
 ['      isIdle,','      isIdle,\n      releasePolicy,'],
 ['    this.reconcile();\n    if(this.state.recoveryPending)return;','    this.reconcile();\n    if(this.state.recoveryPending)return;\n    if(!this.releasePolicy.api){this.state={...this.state,status:"unconfigured",message:"独立版尚未配置在线发行源；请从独立版安装包手动升级，不会下载原版。",nextCheckAt:Date.now()+DAY};this.changed();return;}'],
 ['await this.fetchBytes(RELEASE_API, {','await this.fetchBytes(this.releasePolicy.api, {\n              policy:this.releasePolicy,'],
 ['selected = selectRelease(release, this.version);','selected = selectRelease(release, this.version,{policy:this.releasePolicy});'],
 ['this.fetchBytes(selected.zip.browser_download_url, {','this.fetchBytes(selected.zip.browser_download_url, {\n          policy:this.releasePolicy,'],
 ['this.fetchBytes(selected.sums.browser_download_url, {','this.fetchBytes(selected.sums.browser_download_url, {\n          policy:this.releasePolicy,']
]);
console.log('Independent update policy installed; no upstream network feed enabled.');

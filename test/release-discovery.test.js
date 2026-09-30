import test from 'node:test';import assert from 'node:assert/strict';
import {createReleaseDiscovery} from '../src/update/release-discovery.js';
const base='https://github.com/golem-workers/sidewisp-plugin/releases/download/v0.2.36/';
const release={tag_name:'v0.2.36',assets:[{name:'fleet-rollout.json',browser_download_url:base+'fleet-rollout.json'}]};
const cohort='openclaw/0.2.35/2026.9.6';
const manifest={schema:'sidewisp.verified-fleet.v1',environments:['staging'],version:'0.2.36',commit:'a'.repeat(40),sha256:'b'.repeat(64),deliveryMode:'host-idle-hot-reload-v1',verifiedMigrations:[cohort],migrationEvidence:[{cohort,targetVersion:'0.2.36',artifactSha256:'b'.repeat(64),status:'completed',sourceUpdaterTested:true,isolated:true,gatewayRestarts:0}]};
test('an existing new-updater installation discovers a proven release without backend mutation',async()=>{
 const seen=[];const d=createReleaseDiscovery({currentVersion:'0.2.35',runtimeVersion:'2026.9.6',environment:'staging',schedule:v=>{seen.push(v);return true;},fetchImpl:async url=>({ok:true,json:async()=>url.endsWith('fleet-rollout.json')?manifest:[release]})});
 assert.equal(await d.check(),true);assert.equal(seen[0].targetVersion,'0.2.36');assert.equal(seen[0].sha256,manifest.sha256);
});
test('unproven migrations, previous restart-based rollouts, drafts and foreign manifests are ignored',async()=>{
 for(const [r,m] of [[release,{...manifest,deliveryMode:undefined}],[release,{...manifest,verifiedMigrations:[]}],[release,{...manifest,migrationEvidence:[]}],[{...release,draft:true},manifest],[{...release,assets:[{name:'fleet-rollout.json',browser_download_url:'https://example.com/evil'}]},manifest]]){
 const d=createReleaseDiscovery({currentVersion:'0.2.35',runtimeVersion:'2026.9.6',environment:'staging',schedule:()=>assert.fail('unsafe schedule'),fetchImpl:async url=>({ok:true,json:async()=>url.endsWith('fleet-rollout.json')?m:[r]})});assert.equal(await d.check(),false);
 }
});

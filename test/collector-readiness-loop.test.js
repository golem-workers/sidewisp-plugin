import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=fs.readFileSync(process.env.PLUGIN_SOURCE || new URL('../src/adapters/openclaw/plugin.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('    const localCollectorReady'),source.indexOf('    registerConnectTool(api'));
function ready(overrides={}){return new Function('scope','with(scope){'+block+';return localCollectorReady;}')({activation:{required:()=>false},config:{enabled:true},spool:{},uploader:{},spoolFailure:null,healthTimer:null,collector:{isRunning:()=>true,status:async()=>({running:true})},...overrides})();}
test('running adapter without authorization/heartbeat timer is not ready',async()=>{assert.equal(await ready(),false)});
test('unpaired running service with live timer remains ready',async()=>{assert.equal(await ready({healthTimer:{ready:()=>true}}),true)});
test('spool failure prevents readiness even with timer',async()=>{assert.equal(await ready({healthTimer:{ready:()=>true},spoolFailure:{code:'failed'}}),false)});

test('live heartbeat cannot advertise task readiness in affected hot generation',async()=>{assert.equal(await ready({activation:{required:()=>true},healthTimer:{ready:()=>true}}),false)});

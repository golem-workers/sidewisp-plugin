import test from 'node:test';
import assert from 'node:assert/strict';
import {createContextUsageDelivery} from '../src/delivery/context-usage.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('context samples at 30s start cadence without full diagnostics; stop prevents rescheduling',async()=>{
 let clock=1800000000000,callback,delay,cleared=false,calls=0;const bodies=[];
 const delivery=createContextUsageDelivery({now:()=>clock,collect:async()=>{calls++;return [{key:'context.used',value:123},{key:'context.capacity',value:456},{key:'context.measured_at_ms',value:clock}];},
 credentialProvider:{current:async()=>({status:'active',installationId:'sw_ins_example1234',secret:'test-secret'})},endpoint:'https://example.test',
 fetchImpl:async(url,opts)=>{assert.equal(url.pathname,'/v1/context-usage');const b=JSON.parse(opts.body);bodies.push(b);clock+=2000;return {ok:true,json:async()=>({schema:'sidewisp.context-usage-ack.v1',observedAtMs:b.observedAtMs})};},
 setTimer:(fn,ms)=>{callback=fn;delay=ms;return 1;},clearTimer:()=>{cleared=true;}});
 delivery.start();await flush();assert.equal(calls,1);assert.equal(delay,28000);assert.equal(delivery.status().status,'sent');
 clock+=delay;callback();await flush();assert.equal(bodies[1].observedAtMs-bodies[0].observedAtMs,30000);
 assert.deepEqual(Object.keys(bodies[0]).sort(),['schema','installationId','observedAtMs','used','capacity','measuredAtMs'].sort());
 await delivery.stop();assert.equal(cleared,true);callback();await flush();assert.equal(calls,2);
});
test('unavailable context clears previous sample; transport failure does not create backlog',async()=>{
 let sample;const d=createContextUsageDelivery({collect:async()=>[],credentialProvider:{current:async()=>({status:'active',installationId:'sw_ins_example1234',secret:'test'})},endpoint:'https://example.test',fetchImpl:async(_,o)=>{sample=JSON.parse(o.body);throw Error('network');}});
 await Promise.all([d.run(),d.run()]);assert.equal(sample.used,null);assert.equal(sample.capacity,null);assert.equal(d.status().status,'retry');await d.stop();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

test('real process STOP/CONT expires a pre-suspension transport without manual reconnect', {skip:process.platform==='win32',timeout:10000}, async t=>{
 const moduleUrl=new URL('../src/transport/deadline.js',import.meta.url).href;
 const child=fork('--eval',[
  `import {createTransportDeadline} from ${JSON.stringify(moduleUrl)};
   const deadline=createTransportDeadline({timeoutMs:300,resolutionMs:20});
   deadline.signal.addEventListener('abort',()=>{
    const reason=deadline.signal.reason.name;deadline.close();
    process.send({status:'expired',reason},()=>process.disconnect());
   },{once:true});
   process.send({status:'armed'});`,
 ],{execArgv:['--input-type=module'],stdio:['ignore','ignore','pipe','ipc']});
 t.after(()=>{if(child.exitCode===null){child.kill('SIGCONT');child.kill('SIGKILL');}});
 const [[armed]]=await Promise.all([once(child,'message'),once(child,'spawn')]);
 assert.equal(armed.status,'armed');
 child.kill('SIGSTOP');
 await delay(600);
 const resumed=once(child,'message');
 child.kill('SIGCONT');
 const [result]=await resumed;
 assert.deepEqual(result,{status:'expired',reason:'TimeoutError'});
 const [code]=await once(child,'exit');assert.equal(code,0);
});

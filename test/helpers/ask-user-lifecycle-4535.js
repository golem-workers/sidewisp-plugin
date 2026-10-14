import { createHash } from 'node:crypto';
import { createOpenClawQuestionObserver } from '../../src/adapters/openclaw/questions.js';
import { createOpenClawUserTaskLifecycle, registerOpenClawHooks, openClawAgentEventInput } from '../../src/adapters/openclaw/hooks.js';
import { normalizeRuntimeEvent } from '../../src/core/normalize.js';
const session='agent:main:telegram:group:fixture';
const run='87f6a5e5-1519-4fb6-ac6f-7578cfc0eb2d';
const toolCall='exec-c7af3031-6f2a-4d73-b41f-9d8f2bdd5257';
export const qid=(r=run,t=toolCall)=>'ask_'+createHash('sha256').update(`${r}\0${t}`).digest('hex').slice(0,32);
function timers(){let clock=0;const jobs=new Map();return{now:()=>clock,setTimeoutFn(fn,ms){const id={unref(){}};jobs.set(id,{fn,at:clock+ms});return id;},clearTimeoutFn:id=>jobs.delete(id),advance(ms){clock+=ms;for(const[id,j]of [...jobs])if(j.at<=clock){jobs.delete(id);j.fn();}}};}
export function setup(){
 const time=timers(),registry=new Map(),pendingRegistry=new Map(),events=[],hooks=new Map();let seq=0,nativeSeq=0;
 const envelope=()=>({eventId:'sw_evt_fixture'+String(++seq).padStart(10,'0'),installationId:'sw_ins_fixture',sequence:seq,occurredAt:'2026-10-13T03:30:37.000Z',observedAt:'2026-10-13T03:30:37.000Z',runtime:{version:'2026.9.8'},source:{kind:'hook',adapterVersion:'0.2.69-candidate.3'}});
 const persist=e=>{const accepted=life.process(e);if(accepted){events.push(accepted);life.commit(accepted);}return accepted;};
 const life=createOpenClawUserTaskLifecycle({...time,onDeferred:e=>{events.push(e);return true;}});
 const observer=createOpenClawQuestionObserver({now:time.now,pollMs:100000,readRegistry:()=>registry,readPendingRegistry:()=>pendingRegistry,emit:i=>persist(normalizeRuntimeEvent('openclaw',i,envelope()).event)});
 registerOpenClawHooks({on:(n,h)=>hooks.set(n,h)},{envelopeFactory:envelope,emit:persist});
 const boundary=id=>persist({type:'message.received',correlation:{sessionId:session,messageId:id},details:{component:'before_dispatch'}});
 const native=async(stream,data,r=run,s=undefined)=>{const e={stream,data,runId:r,seq:++nativeSeq,...(s?{sessionKey:s}:{})};observer.observe(e);await observer.drain();const i=openClawAgentEventInput(e);return i&&persist(normalizeRuntimeEvent('openclaw',i,envelope()).event);};
 const end=(data={})=>native('lifecycle',{phase:'end',stopReason:'end_turn',executionSettled:true,endedAt:100,...data},run,session);
 const final=async(text='Получен ответ «no» — цвет не выбран.',id='4521')=>{let observe;hooks.get('reply_dispatch')({sessionKey:session,ctx:{MessageSid:id}},{dispatcher:{appendBeforeDeliver:h=>observe=h}});observe({text},{kind:'final'});await new Promise(r=>setImmediate(r));};
 const question=async(text='Какой цвет выбрать?',r=run,t=toolCall,s=session)=>{
   await native('tool',{phase:'start',name:'ask_user',toolCallId:t},r);
   let resolve,reject;const answer=new Promise((r,j)=>{resolve=r;reject=j;});resolve.reject=reject;
   registry.set(qid(r,t),{questionId:qid(r,t),sessionKey:s,questions:[{question:text}],phase:{kind:'answerable'},expiresAtMs:100000});
   pendingRegistry.set(s,{kind:'gateway',questionId:qid(r,t),sessionKey:s,answer});observer.scan();await observer.drain();return resolve;
 };
 const result=()=>native('tool',{phase:'result',name:'ask_user',toolCallId:toolCall,result:{contentItems:[{type:'text',text:'protocol response intentionally not parsed'}],success:true}});
 boundary('4521');persist(normalizeRuntimeEvent('openclaw',openClawAgentEventInput({stream:'lifecycle',sessionKey:session,runId:run,data:{phase:'start'}}),envelope()).event);
 return {time,registry,pendingRegistry,events,hooks,life,observer,boundary,native,end,final,question,result,dispose:()=>observer.dispose()};
}

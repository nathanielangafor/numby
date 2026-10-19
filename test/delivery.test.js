import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core.js';
import { createApp } from '../src/server.js';

test('per-message outcome preserves typed failure and isolates tenants without retrying', async () => {
  const store = new Store(':memory:', 'a'.repeat(64));
  let receive, fail = true, calls = 0;
  const {server} = createApp({store, provider:{ready:true, async connect(fn){receive=fn}, async send(){
    calls++;
    if(fail) throw Object.assign(new Error('private message and secret'), {code:'recipientCoolingDown',grpcCode:8,retryable:true,source:'spectrum-imessage',requestId:'request-test-123'});
    return {id:'spc-msg-result'};
  }}});
  function pair(phone){const setup=store.bootstrap();const challenge=store.begin(phone,{id:phone,assignedPhoneNumber:'+14155550100'},setup.setupToken).challenge;
    inbound(phone,challenge);return store.completeSetup(setup.setupToken,'connect').token;}
  function inbound(phone,text){const id=crypto.randomUUID();receive({platform:'imessage',type:'dm',phone:'shared',id:'dm'}, {id,direction:'inbound',sender:{id:phone},content:{type:'text',text}});return id;}
  const token=pair('+12405550101'), other=pair('+12405550102');
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const status=(id,who=token)=>fetch(base+'/api/agent/message-status?id='+id,{headers:{Authorization:'Bearer '+who}});
  async function send(id){const job=store.lease(store.agent(token));assert.equal(job.id,id);
    const r=await fetch(base+'/api/agent/send',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({id,lease:job.lease,text:'private reply'})});assert.equal(r.status,202);}
  try{
    const id=inbound('+12405550101','test');await send(id);
    const result=await (await status(id)).json();
    assert.equal(result.state,'uncertain');assert.equal(result.delivery.code,'recipientCoolingDown');assert.equal(result.delivery.grpcCode,8);
    assert.equal(result.providerConfirmed,false);assert.equal(result.deviceDeliveryConfirmed,null);
    assert.equal(result.needsAttention,true);assert.equal(JSON.stringify(result).includes('private'),false);
    assert.equal((await status(id,other)).status,404);assert.equal((await status(id,'invalid')).status,401);
    assert.equal(calls,1);
    fail=false;const id2=inbound('+12405550101','next');await send(id2);
    const sent=await (await status(id2)).json();assert.equal(sent.state,'sent');assert.equal(sent.providerConfirmed,true);
    assert.equal(sent.delivery.providerMessageId,'spc-msg-result');assert.equal(sent.deviceDeliveryConfirmed,null);
    assert.equal((await (await status(id)).json()).state,'uncertain');assert.equal(calls,2);
  }finally{await new Promise(r=>server.close(r));store.db.close()}
});

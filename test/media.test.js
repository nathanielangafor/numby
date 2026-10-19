import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/core.js';
import {createApp} from '../src/server.js';
import {deliver, normalizeInbound} from '../src/provider.js';
import {validateParts, readBoundedAttachment, MAX_MEDIA_BYTES} from '../src/media.js';
const part = {type:'attachment', name:'photo.png', mimeType:'image/png', data:Buffer.from('test image bytes').toString('base64')};
const space = {id:'dm', type:'dm', phone:'shared', platform:'imessage'};
const message = {id:'m', platform:'imessage', direction:'inbound', sender:{id:'+12405550101'}, content:{type:'text', text:'photo please'}};

test('media validates bounded bytes, filenames and canonical encoding without accepting URLs', () => {
  assert.equal(validateParts([part])[0].name, 'photo.png');
  for (const override of [{name:'../secret'}, {data:'not base64'}, {url:'http://localhost/'}, {mimeType:'image/png\r\nx:1'}, {type:'voice'}, {data:Buffer.alloc(MAX_MEDIA_BYTES+1).toString('base64')}])
    assert.throws(() => validateParts([{...part,...override}]));
  assert.throws(() => validateParts(Array(9).fill(part)));
  assert.throws(() => validateParts([{...part, data:Buffer.alloc(6*1024*1024).toString('base64')},{...part,data:Buffer.alloc(6*1024*1024).toString('base64')}]));
});

test('real SDK builds media and inline media replies, stops a partially failed batch', async () => {
  const seen=[];
  const channel={...space, async send(c) {const built=await c.build(); seen.push(built);return {id:'sent'};}};
  await deliver(channel,message,[part], 'reply-content');
  assert.equal(seen[0].type,'reply'); assert.equal(seen[0].target.id,'m');
  assert.equal((await seen[0].content.read()).toString(),'test image bytes');
  await deliver(channel,message,[{type:'text',text:'caption'},{...part,type:'voice',name:'audio.m4a',mimeType:'audio/mp4'}], 'send-content');
  assert.equal(seen[1].type,'text');assert.equal(seen[2].type,'voice');
  let calls=0;
  await assert.rejects(deliver({...space,async send(){calls++;if(calls===2)throw new Error('failed'); return {id:'sent'};}}, message,[part,part,part],'send-content'));
  assert.equal(calls,2);
});

test('inbound media keeps metadata only; bounded streaming cancels oversized downloads', async () => {
  const normalized=normalizeInbound(space,{...message,content:{type:'attachment',id:'file-id',name:'photo.png',mimeType:'image/png',size:12,read:()=>{},secret:'never'}});
  assert.deepEqual(normalized.message.content,{type:'attachment',id:'file-id',name:'photo.png',mimeType:'image/png',size:12});
  let cancelled=false;
  await assert.rejects(readBoundedAttachment({stream:async()=>new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX_MEDIA_BYTES+1));},cancel(){cancelled=true;}})}),/exceeds/);
  assert.equal(cancelled,true);
  assert.equal((await readBoundedAttachment({stream:async()=>new ReadableStream({start(c){c.enqueue(Buffer.from('bytes'));c.close();}})})).toString(),'bytes');
});

test('media HTTP enforces tenant and lease ownership, sends once, and download does not consume event', async () => {
  const store=new Store(':memory:','b'.repeat(64));
  function paired(phone) {
    const s=store.bootstrap(),r=store.begin(phone,{id:phone,assignedPhoneNumber:'+14155550100'},s.setupToken);
    store.ingest(space,{...message,id:crypto.randomUUID(),sender:{id:phone},content:{type:'text',text:r.challenge}});
    return store.completeSetup(s.setupToken,'connect').token;
  }
  const token=paired(message.sender.id), other=paired('+12405550102');
  let sends=0,downloads=0,signals=0;
  const {server,closeStreams}=createApp({store,provider:{ready:true,async connect(){},async send(payload,parts,op){sends++;assert.equal(op,'reply-content');assert.deepEqual(parts,[part]);},async download(payload){downloads++;assert.equal(payload.message.content.id,'file');return Buffer.from('private bytes');},async signal(){signals++;}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body,credential=token)=>fetch(base+'/api/agent/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},body:JSON.stringify(body)});
  try {
    store.ingest(space,{...message,id:'media-event',content:{type:'attachment',id:'file',name:'photo.png',mimeType:'image/png'}});
    const event=store.lease(store.agent(token));
    assert.equal(event.attachment.name,'photo.png');
    const request={id:event.id,lease:event.lease};
    assert.equal((await post('download',request,other)).status,404);
    assert.equal((await post('download',{...request,lease:'bad'})).status,409);
    assert.equal((await post('download',request)).status,200);
    assert.equal(await (await post('download',request)).text(),'private bytes');
    assert.equal(downloads,2);
    assert.equal((await post('typing',{...request,active:true})).status,200);assert.equal(signals,1);
    assert.equal((await post('reply-content',{...request,parts:[part]},null)).status,401);
    assert.equal((await post('reply-content',{...request,parts:[{...part,name:'../bad'}]})).status,400);
    assert.equal((await post('reply-content',{...request,parts:[part],recipient:'other'})).status,400);
    assert.equal((await post('reply-content',{...request,parts:[part]})).status,202);
    assert.equal((await post('reply-content',{...request,parts:[part]})).status,202);
    assert.equal(sends,1);
    assert.equal((await post('download',request)).status,409);
    const row=store.db.prepare('SELECT payload,reply,state FROM jobs WHERE id=?').get(event.id);
    assert.equal(row.payload,null);assert.equal(row.reply,null);assert.equal(row.state,'sent');
  } finally {closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.db.close();}
});

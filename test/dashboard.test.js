import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/core.js';
import {createApp} from '../src/server.js';
import {dashboardData} from '../src/dashboard.js';
const runtime={connected:()=>true,providerReady:()=>true};
test('dashboard aggregation distinguishes acknowledgements, acceptance, backlog and private payloads',()=>{
 const store=new Store(':memory:','b'.repeat(64));const now=Date.now();
 store.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run('account','+12405550101','+14155550100','provider',1,now);
 store.db.prepare('INSERT INTO agents VALUES(?,?,?)').run('secret-token','account',now);
 const insert=store.db.prepare('INSERT INTO jobs(id,account_id,payload,state,lease,reply,created,updated,operation,delivery_info) VALUES(?,?,?,?,?,?,?,?,?,?)');
 insert.run('one','account','private-body','sent','secret-lease','private-reply',now-1000,now,'send',JSON.stringify({elapsedMs:200,payload:'private-content'}));
 insert.run('two','account',null,'sent',null,null,now-2000,now,'ack',null);
 insert.run('old','account',null,'uncertain',null,null,now-9*86400e3,now,'send',null);
 insert.run('pending','account',null,'queued',null,null,now,now,'send',null);
 const data=dashboardData(store,new URL('https://numby.io/dashboard/api'),runtime,now);
 assert.equal(data.summary.received,3);assert.equal(data.summary.accepted,1);assert.equal(data.summary.acknowledged,1);assert.equal(data.summary.attention,1);assert.equal(data.summary.pending,1);assert.equal(data.summary.providerP95Ms,200);assert.equal(data.summary.endToEndP95Ms,1000);
 for(const secret of ['+12405550101','private-body','private-reply','private-content','secret-token','secret-lease'])assert.ok(!JSON.stringify(data).includes(secret));
 assert.equal(dashboardData(store,new URL('https://n/dashboard/api?days=30&state=attention&q=0101'),runtime,now).jobs[0].id,'old');
 for(const query of ['days=2','page=0','state=nope'])assert.throws(()=>dashboardData(store,new URL('https://n/dashboard/api?'+query),runtime,now));
 store.db.close();
});
test('private dashboard requires authentication, rejects cross origin and revokes logout',async()=>{
 const store=new Store(':memory:','a'.repeat(64));const {server,closeStreams}=createApp({store,dashboardPassword:'test-secret'});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=(path,password,headers={})=>fetch(base+'/dashboard/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Numby-Dashboard':'1',...headers},body:JSON.stringify({password})});
 try{
 assert.equal((await fetch(base+'/dashboard/api')).status,401);
 const shell=await fetch(base+'/dashboard');assert.equal(shell.status,200);assert.match(shell.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await post('login','test-secret',{Origin:'https://evil.test'})).status,403);
 assert.equal((await post('login','wrong')).status,401);
 const login=await post('login','test-secret');assert.equal(login.status,200);const cookie=login.headers.get('set-cookie');for(const flag of ['Secure','HttpOnly','SameSite=Strict','Path=/'])assert.ok(cookie.includes(flag));
 const headers={Cookie:cookie.split(';')[0]};assert.equal((await fetch(base+'/dashboard/api',{headers})).status,200);
 assert.equal((await fetch(base+'/dashboard/api?days=0',{headers})).status,400);
 assert.equal((await post('logout','',headers)).status,200);assert.equal((await fetch(base+'/dashboard/api',{headers})).status,401);
 }finally{closeStreams();await new Promise(r=>server.close(r));store.db.close();}
});

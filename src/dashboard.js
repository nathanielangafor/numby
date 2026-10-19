import {randomBytes, timingSafeEqual, createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Failure, hash} from './core.js';

const COOKIE = '__Host-numby-dashboard';
const SESSION_MS = 12 * 3600e3;
const STATES = ['queued','leased','outbound','sending','sent','uncertain','failed','expired'];
const PENDING = "('queued','leased','outbound','sending')";
const equal = (a,b) => timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
const number = value => Number(value || 0);
const percentile = values => values.length ? values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1] : null;
const safeDelivery = value => {
  try {
    const source=JSON.parse(value), result={};
    for(const key of ['reason','errorType','code','grpcCode','retryable','source','requestId','elapsedMs','providerMessageId'])
      if(['string','number','boolean'].includes(typeof source?.[key])) result[key]=source[key];
    return result;
  } catch { return null; }
};

export function dashboardData(store, url, runtime, now=Date.now()) {
  const days=Number(url.searchParams.get('days') || 7);
  const page=Number(url.searchParams.get('page') || 1);
  const state=url.searchParams.get('state') || 'all';
  const query=(url.searchParams.get('q') || '').trim();
  if(![1,7,30].includes(days) || !Number.isInteger(page) || page<1 || page>100000 || !['all','attention','pending',...STATES].includes(state) || query.length>100)
    throw new Failure(400,'Invalid dashboard filter.');
  const since=now-days*86400e3;
  const db=store.db;
  const totals=db.prepare(`SELECT count(*) received, sum(state='sent' AND operation!='ack') accepted,
    sum(state='sent' AND operation='ack') acknowledged FROM jobs WHERE created>=?`).get(since);
  const backlog=db.prepare(`SELECT sum(state IN ${PENDING}) pending, sum(state IN ('uncertain','failed')) attention,
    min(CASE WHEN state IN ${PENDING} THEN created END) oldest FROM jobs`).get();
  const accounts=db.prepare(`SELECT a.id,a.phone,a.created,EXISTS(SELECT 1 FROM agents g WHERE g.account_id=a.id) paired,
    count(j.id) messages,max(j.created) lastMessageAt,sum(j.state IN ${PENDING}) pending,
    sum(j.state IN ('uncertain','failed')) attention FROM accounts a LEFT JOIN jobs j ON j.account_id=a.id GROUP BY a.id ORDER BY a.created DESC`).all()
    .map(a=>({id:a.id,label:'Phone •••• '+a.phone.slice(-4),createdAt:a.created,paired:!!a.paired,
      listenerConnected:!!a.paired && runtime.connected(a.id),messages:a.messages,lastMessageAt:a.lastMessageAt,
      pending:number(a.pending),attention:number(a.attention)}));
  const bucket=days===1 ? 3600e3 : 86400e3;
  const first=Math.floor(since/bucket)*bucket;
  const counts=db.prepare(`SELECT CAST(created / ? AS INTEGER)*? bucket,count(*) received,
    sum(state='sent' AND operation!='ack') accepted,sum(state IN ('uncertain','failed')) attention
    FROM jobs WHERE created>=? GROUP BY bucket`).all(bucket,bucket,since);
  const byBucket=new Map(counts.map(row=>[row.bucket,row]));
  const activity=[];
  for(let time=first;time<=now;time+=bucket) activity.push({time,received:0,accepted:0,attention:0,...byBucket.get(time)});
  const durations=db.prepare("SELECT created,updated,delivery_info FROM jobs WHERE created>=? AND state='sent' AND operation!='ack'").all(since);
  const endToEnd=durations.map(row=>row.updated-row.created).filter(n=>n>=0);
  const provider=durations.map(row=>safeDelivery(row.delivery_info)?.elapsedMs).filter(n=>Number.isFinite(n)&&n>=0);
  const where=['j.created>=?'], params=[since];
  if(state==='pending')where.push(`j.state IN ${PENDING}`);
  else if(state==='attention')where.push("j.state IN ('uncertain','failed')");
  else if(state!=='all'){where.push('j.state=?');params.push(state);}
  if(query){where.push('(instr(lower(j.id),lower(?))>0 OR instr(lower(j.account_id),lower(?))>0 OR instr(substr(a.phone,-4),?)>0)');params.push(query,query,query);}
  const from=' FROM jobs j JOIN accounts a ON a.id=j.account_id WHERE '+where.join(' AND ');
  const total=db.prepare('SELECT count(*) n'+from).get(...params).n;
  const jobs=db.prepare('SELECT j.id,j.account_id,j.state,j.operation,j.attempts,j.created,j.updated,j.lease_until,j.delivery_info,substr(a.phone,-4) suffix'+from+' ORDER BY j.created DESC,j.id DESC LIMIT 25 OFFSET ?')
    .all(...params,(page-1)*25).map(j=>({id:j.id,accountId:j.account_id,label:'Phone •••• '+j.suffix,state:j.state,
      operation:j.operation,attempts:j.attempts,createdAt:j.created,updatedAt:j.updated,
      leaseUntil:j.state==='leased'?j.lease_until:null,delivery:safeDelivery(j.delivery_info),
      elapsedMs:j.state==='sent'?j.updated-j.created:null,deviceDeliveryConfirmed:null}));
  return {generatedAt:now,days,summary:{received:totals.received,accepted:number(totals.accepted),acknowledged:number(totals.acknowledged),
    paired:accounts.filter(a=>a.paired).length,listeners:accounts.filter(a=>a.listenerConnected).length,
    pending:number(backlog.pending),attention:number(backlog.attention),oldestPendingAt:backlog.oldest,
    endToEndP95Ms:percentile(endToEnd),providerP95Ms:percentile(provider),durationSamples:endToEnd.length,providerSamples:provider.length},
    system:{providerReady:runtime.providerReady(),uptimeSeconds:Math.floor(process.uptime()),memoryBytes:process.memoryUsage().rss,
      setupReservations:db.prepare('SELECT count(*) n FROM setups WHERE expires>? AND verified=0').get(now).n,
      unverifiedAccounts:db.prepare('SELECT count(*) n FROM accounts WHERE verified=0').get().n,
      deviceReceiptsAvailable:false},activity,accounts,jobs,pagination:{page,pageSize:25,total,pages:Math.max(1,Math.ceil(total/25))}};
}

export function createDashboard({store,origin,runtime,password=process.env.DASHBOARD_PASSWORD || ''}) {
  const sessions=new Map();
  const root=new URL('../public/dashboard/',import.meta.url);
  const assets=new Map([['/dashboard','index.html'],['/dashboard/','index.html'],['/dashboard/app.js','app.js'],['/dashboard/style.css','style.css'],['/dashboard/heading.woff2','heading.woff2'],['/dashboard/logo.svg','logo.svg']]);
  const json=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(value));};
  const cookie=req=>req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  const valid=req=>{const value=cookie(req);if(!value || !password)return false;const expiry=sessions.get(value);return !!expiry&&expiry>Date.now();};
  return async function handle(req,res,url) {
    if(url.pathname!=='/dashboard'&&!url.pathname.startsWith('/dashboard/'))return false;
    res.setHeader('X-Robots-Tag','noindex, nofollow');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    try {
      if(req.method==='GET'&&assets.has(url.pathname)){
        const file=assets.get(url.pathname),ext=file.split('.').at(-1);
        res.setHeader('Content-Type',({html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',woff2:'font/woff2',svg:'image/svg+xml'})[ext]);
        res.end(readFileSync(new URL(file,root)));return true;
      }
      if(!password)throw new Failure(503,'Operator access is not configured.');
      for(const [session,expires] of sessions)if(expires<=Date.now())sessions.delete(session);
      if(['/dashboard/login','/dashboard/logout'].includes(url.pathname)&&req.method==='POST'){
        if(req.headers['x-numby-dashboard']!=='1'||(req.headers.origin&&req.headers.origin!==origin))throw new Failure(403,'Use the dashboard sign-in form.');
        if(url.pathname.endsWith('/logout')){sessions.delete(cookie(req));json(res,200,{ok:true},{'Set-Cookie':`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});return true;}
        store.limit('dashboard-login:'+hash(req.headers['x-real-ip']||req.socket.remoteAddress||''),10,15*60e3);
        let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>4096)throw new Failure(413,'Request too large.');}
        let input;try{input=JSON.parse(raw);}catch{throw new Failure(400,'Invalid sign-in request.');}
        if(typeof input?.password!=='string'||!equal(input.password,password))throw new Failure(401,'Incorrect access key.');
        if(sessions.size>=100)throw new Failure(429,'Too many active sessions. Try again later.');
        const value=randomBytes(32).toString('base64url');
        sessions.set(value,Date.now()+SESSION_MS);
        json(res,200,{ok:true},{'Set-Cookie':`${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS/1000}`});return true;
      }
      if(req.method==='GET'&&url.pathname==='/dashboard/api'){
        if(!valid(req))throw new Failure(401,'Sign in to view system activity.');
        store.limit('dashboard-read:'+hash(cookie(req)),120,60000);
        json(res,200,dashboardData(store,url,runtime));return true;
      }
      throw new Failure(404,'Not found.');
    }catch(error){json(res,error.status||500,{error:error.status?error.message:'Dashboard unavailable. Try refreshing.'});return true;}
  };
}

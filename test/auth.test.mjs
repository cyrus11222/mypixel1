import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStore, GitHubStore, emptyDatabase } from '../lib/store.mjs';
import { AuthService, REMEMBER_SECONDS, SESSION_SECONDS, tokenHash } from '../lib/auth.mjs';
const secret = 'test-only-'.repeat(8);
const credentials = (username, remember = true) => ({ username, password:'a-long-test-password', remember });

test('salted password storage, 30-day persistence, expiry, rotation and revocation', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'mypixel-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let now=Date.now();const store=new LocalStore(path.join(dir,'user.txt'));
 const auth=new AuthService(store,{now:()=>now,rateSecret:secret});
 const first=await auth.register(credentials('Builder'),'ip1');
 const second=await auth.register(credentials('Engineer',false),'ip2');
 const text=await readFile(store.file,'utf8');const db=JSON.parse(text);
 assert.ok(!text.includes(credentials('x').password));assert.ok(!text.includes(first.token));
 assert.notEqual(db.users[0].passwordHash,db.users[1].passwordHash);
 assert.equal(db.users[0].sessions[0].hash,tokenHash(first.token));
 assert.equal(db.users[0].sessions[0].expiresAt-now,REMEMBER_SECONDS*1000);
 assert.equal(db.users[1].sessions[0].expiresAt-now,SESSION_SECONDS*1000);
 const restarted=new AuthService(new LocalStore(store.file),{now:()=>now,rateSecret:secret});
 assert.equal((await restarted.session(first.token)).username,'Builder');
 await assert.rejects(()=>auth.login({...credentials('Builder'),password:'incorrect-password'},'ip3'),e=>e.status===401);
 await assert.rejects(()=>auth.register(credentials('builder'),'ip4'),e=>e.status===409);
 const rotated=await auth.login(credentials('BUILDER'),'ip3',first.token);
 assert.equal(await auth.session(first.token),null);
 assert.ok(await auth.session(rotated.token));
 await auth.logout(rotated.token);assert.equal(await restarted.session(rotated.token),null);
 const remembered=await auth.login(credentials('Builder'),'ip3');
 now+=REMEMBER_SECONDS*1000-1;assert.ok(await restarted.session(remembered.token));
 now+=1;assert.equal(await restarted.session(remembered.token),null);assert.equal(await auth.session(second.token),null);
 assert.equal(await auth.session('forged-token'),null);
});

test('rate limits survive service restarts and malformed storage fails closed',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mypixel-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'user.txt');const store=new LocalStore(file);
 const a=new AuthService(store,{rateSecret:secret});
 for(let i=0;i<10;i++)await a.limit('ip','same_name','login');
 const b=new AuthService(new LocalStore(file),{rateSecret:secret});
 await assert.rejects(()=>b.limit('other-ip','same_name','login'),e=>e.status===429);
 await writeFile(file,'not valid JSON');await assert.rejects(()=>store.mutate(()=>{}));
 assert.equal(await readFile(file,'utf8'),'not valid JSON');
});

test('GitHub creates user.txt, checks privacy, and merges a conflicting update',async()=>{
 let remote=null, revision=0, writes=0, conflict=true;
 const fetcher=async(url,options)=>{
  if(!url.includes('/contents/'))return Response.json({private:true});
  if(options.method!=='PUT')return remote?Response.json({type:'file',encoding:'base64',size:Buffer.byteLength(remote),content:Buffer.from(remote).toString('base64'),sha:String(revision)}):new Response('',{status:404});
  writes++; const request=JSON.parse(options.body);
  if(conflict){conflict=false;const db=emptyDatabase();db.limits.push({key:'concurrent',count:1,resetAt:123});remote=JSON.stringify(db);revision++;return new Response('',{status:409});}
  assert.equal(request.sha,String(revision));remote=Buffer.from(request.content,'base64').toString();revision++;return Response.json({content:{sha:String(revision)}},{status:200});
 };
 const store=new GitHubStore({owner:'test',repo:'private',branch:'main',token:'test-only',fetcher});
 await store.mutate(db=>db.limits.push({key:'ours',count:1,resetAt:456}));
 assert.equal(writes,2);assert.deepEqual(JSON.parse(remote).limits.map(x=>x.key),['concurrent','ours']);
 const denied=new GitHubStore({owner:'test',repo:'public',branch:'main',token:'test-only',fetcher:async()=>Response.json({private:false})});
 await assert.rejects(()=>denied.mutate(()=>{}),error=>error.code==='ACCOUNT_KEY_MISSING');
 let created;
 const fresh=new GitHubStore({owner:'test',repo:'new',branch:'main',token:'test-only',fetcher:async(url,opts)=>{
  if(!url.includes('/contents/'))return Response.json({private:true});
  if(opts.method!=='PUT')return new Response('',{status:404});
  created=JSON.parse(opts.body);return Response.json({},{status:201});
 }});
 await fresh.mutate(()=>{});assert.equal(created.sha,undefined);assert.equal(JSON.parse(Buffer.from(created.content,'base64')).schema,1);
});

test('HTTP auth gate, origin checks, cookies, protected files and logout',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mypixel-http-'));
 process.env.AUTH_STORE='local';process.env.LOCAL_DATA_FILE=path.join(dir,'user.txt');process.env.RATE_LIMIT_SECRET=secret;
 delete process.env.VERCEL;
 const {createDevServer}=await import('../dev.mjs');
 const server=createDevServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.address().port}`;process.env.APP_ORIGIN=origin;
 const post=(action,data,cookie='',source=origin)=>fetch(origin+'/api/auth?action='+action,{method:'POST',headers:{'Content-Type':'application/json',Origin:source,Cookie:cookie},body:JSON.stringify(data)});
 let res=await fetch(origin+'/',{redirect:'manual'});assert.equal(res.status,302);assert.equal(res.headers.get('location'),'/login');
 res=await post('register',credentials('WebPlayer'),'','https://attacker.invalid');assert.equal(res.status,403);
 res=await post('register',credentials('WebPlayer'));assert.equal(res.status,201);
 const raw=res.headers.get('set-cookie');const sessionCookie=raw.split(';')[0];
 assert.match(raw,/HttpOnly/);assert.match(raw,/SameSite=Lax/);assert.match(raw,/Max-Age=2592000/);assert.ok(!(await res.text()).includes('token'));
 res=await fetch(origin+'/',{headers:{Cookie:sessionCookie}});assert.equal(res.status,200);assert.match(await res.text(),/frp-sun.com:56663/);assert.match(res.headers.get('cache-control'),/no-store/);
 for(const file of ['/user.txt','/data/user.txt','/.env','/private/index.html','/lib/store.mjs'])assert.equal((await fetch(origin+file)).status,404);
 res=await post('logout',{},sessionCookie);assert.equal(res.status,200);assert.match(res.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await fetch(origin+'/api/auth?action=me',{headers:{Cookie:sessionCookie}})).status,401);
 res=await post('login',credentials('WebPlayer',false));assert.equal(res.status,200);assert.ok(!res.headers.get('set-cookie').includes('Max-Age'));
 const {cookie}=await import('../lib/http.mjs');process.env.VERCEL='1';process.env.APP_ORIGIN='https://example.com';
 assert.match(cookie('value',true),/^__Host-mypixel_session=value; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000$/);
 delete process.env.VERCEL;
});

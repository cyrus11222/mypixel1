import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubStore } from '../lib/store.mjs';

const makeStore = fetcher => new GitHubStore({ owner:'owner', repo:'accounts', branch:'main', token:'do-not-expose-this-token', fetcher });
test('GitHub setup errors identify missing permissions and branch without exposing secrets', async () => {
  for (const [status,code] of [[401,'GITHUB_TOKEN_INVALID'],[403,'GITHUB_ACCESS_DENIED'],[404,'GITHUB_REPO_UNAVAILABLE'],[429,'GITHUB_RATE_LIMIT']]) {
    const store=makeStore(async()=>new Response('',{status}));
    await assert.rejects(()=>store.read(),e=>e.code===code && !e.publicMessage.includes('do-not-expose'));
  }
  let writes=0;
  const missingBranch=makeStore(async(url,options)=>{
    if(options.method==='PUT')writes++;
    if(url.includes('/contents/')||url.includes('/branches/'))return new Response('',{status:404});
    return Response.json({private:true});
  });
  await assert.rejects(()=>missingBranch.mutate(()=>{}),e=>e.code==='GITHUB_BRANCH_MISSING');
  assert.equal(writes,0);
});

test('validation rejection is not repeatedly retried as a conflict', async()=>{
  let writes=0;
  const store=makeStore(async(url,options)=>{
    if(options.method==='PUT'){writes++;return new Response('',{status:422});}
    if(url.includes('/contents/'))return new Response('',{status:404});
    return Response.json({private:true});
  });
  await assert.rejects(()=>store.mutate(()=>{}),e=>e.code==='GITHUB_WRITE_REJECTED');
  assert.equal(writes,1);
});

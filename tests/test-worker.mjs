import assert from 'node:assert/strict';
import worker from '../analytics-worker/src/index.js';

const origin='https://teenkode.github.io';
const request=(method,path,body=null,from=origin)=>new Request(`https://worker.example${path}`,{
  method,headers:{Origin:from,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})
});
const events=new Map();
class DB{
  prepare(sql){
    return {bind(...params){return {sql,params,all:async()=>{
      const from=params[0],values=[...events.values()].filter(e=>e.day>=from);
      if(sql.includes('SELECT kind,')){
        const counts=new Map();for(const e of values)counts.set(e.kind,(counts.get(e.kind)||0)+1);
        return {results:[...counts].map(([kind,count])=>({kind,count}))};
      }
      if(sql.includes('SELECT tool,')){
        const byTool=new Map();
        for(const e of values){if(e.tool==='site')continue;
          const stats=byTool.get(e.tool)||{tool:e.tool,opens:0,success:0,error:0,cancelled:0,durationMs:0,inputBytes:0,outputBytes:0};
          if(e.kind==='open')stats.opens++;
          if(['success','error','cancelled'].includes(e.kind))stats[e.kind]++;
          stats.durationMs+=e.duration_ms;stats.inputBytes+=e.input_bytes;stats.outputBytes+=e.output_bytes;byTool.set(e.tool,stats);
        }
        return {results:[...byTool.values()]};
      }
      if(sql.includes('SELECT day,')){
        const byDay=new Map();
        for(const e of values){const row=byDay.get(e.day)||{day:e.day,view:0,open:0,success:0,error:0,cancelled:0};row[e.kind]++;byDay.set(e.day,row);}
        return {results:[...byDay.values()].sort((a,b)=>a.day.localeCompare(b.day))};
      }
      throw new Error('Unexpected query');
    }};}};
  }
  async batch(statements){return statements.map(({params})=>{
    const [id,day,kind,tool,duration_ms,input_bytes,output_bytes]=params;
    if(events.has(id))return {meta:{changes:0}};
    events.set(id,{id,day,kind,tool,duration_ms,input_bytes,output_bytes});return {meta:{changes:1}};
  });}
}
const env={DB:new DB(),ALLOWED_ORIGIN:origin};
const now=new Date().toISOString();
const good={id:'b684194b-c752-482a-b74d-5793c3b1da01',ts:now,kind:'success',tool:'video-trim',durationMs:1250,inputBytes:123456,outputBytes:65432};
let res=await worker.fetch(request('OPTIONS','/api/events'),env);
assert.equal(res.status,204);
assert.equal(res.headers.get('Access-Control-Allow-Origin'),origin);
res=await worker.fetch(request('POST','/api/events',{events:[good]}),env);
assert.equal(res.status,200);assert.equal((await res.json()).inserted,1);
res=await worker.fetch(request('POST','/api/events',{events:[good]}),env);
assert.equal(res.status,200);assert.equal((await res.json()).inserted,0);
res=await worker.fetch(request('GET','/api/stats?days=30'),env);
assert.equal(res.status,200);
const totals=await res.json();
assert.equal(totals.kinds.find(x=>x.kind==='success').count,1);
assert.equal(totals.tools[0].inputBytes,123456);
res=await worker.fetch(request('POST','/api/events',{events:[{...good,id:'b684194b-c752-482a-b74d-5793c3b1da02',tool:'../../etc/passwd'}]}),env);
assert.equal(res.status,400);
res=await worker.fetch(request('POST','/api/events',{events:[{...good,id:'b684194b-c752-482a-b74d-5793c3b1da02',ts:'2025-01-01T00:00:00.000Z'}]}),env);
assert.equal(res.status,400);
res=await worker.fetch(request('POST','/api/events',{events:[good]},'https://malicious.invalid'),env);
assert.equal(res.status,403);
res=await worker.fetch(request('GET','/api/stats?days=300'),env);
assert.equal(res.status,400);
res=await worker.fetch(request('GET','/api/health'),env);
assert.equal(res.status,200);
let cleanupCalled=false;
await worker.scheduled({}, {DB:{prepare(query){assert.match(query,/DELETE FROM analytics_events/);return {run:async()=>{cleanupCalled=true;}};}}});
assert(cleanupCalled,'Scheduled D1 retention cleanup must execute');
console.log('Worker tests: CORS, deduplication, querying, validation, invalid origin, period, health, daily cleanup — PASS');

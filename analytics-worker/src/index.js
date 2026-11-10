// Минимальный API общей статистики Lokit (Cloudflare Workers + D1).
// Храним только анонимные события. Не принимаем имена файлов, IP, User-Agent,
// идентификаторы посетителей, произвольные тексты ошибок или содержимое файлов.
const KINDS=new Set(['view','open','success','error','cancelled']);
const TOOLS=new Set([
  'video-trim','mute-video','video-crop','video-flip','video-rotate','video-speed',
  'video-loop','video-filter','video-blur','video-watermark','video-converter',
  'video-compressor','video-volume','video-merge','split-screen','video-to-vr',
  'video-frames','video-metadata','video-to-audio','screen-recorder','webcam-recorder',
  'subtitle-converter','subtitle-shift','subtitle-merger'
]);
const MAX_EVENTS=30;
const DAY_MS=86400000;
const LIMIT=20*1024*1024*1024;
const noStore={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const clamp=value=>Number.isFinite(value)&&value>=0?Math.min(Math.round(value),LIMIT):0;
const safeInt=value=>Number.isFinite(value)&&value>=0?Math.min(Math.round(value),86400000):0;

function headers(origin,allowed){
  const h=new Headers({...noStore,'Content-Type':'application/json; charset=utf-8'});
  if(allowed){h.set('Access-Control-Allow-Origin',origin);h.set('Vary','Origin');h.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');h.set('Access-Control-Allow-Headers','Content-Type');}
  return h;
}
function json(data,status,origin,allowed){return new Response(JSON.stringify(data),{status,headers:headers(origin,allowed)});}
function sanitize(event,now){
  if(!event||typeof event!=='object'||Array.isArray(event))return null;
  if(typeof event.id!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|local-\d{13}-[a-z\d]{5,24})$/i.test(event.id))return null;
  if(!KINDS.has(event.kind))return null;
  if(event.kind==='view'&&event.tool!=='site')return null;
  if(event.kind!=='view'&&!TOOLS.has(event.tool))return null;
  if(typeof event.ts!=='string'||!/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(event.ts))return null;
  const timestamp=Date.parse(event.ts);
  if(!Number.isFinite(timestamp)||timestamp<now-7*DAY_MS||timestamp>now+5*60*1000)return null;
  const day=new Date(timestamp).toISOString().slice(0,10);
  const isResult=['success','error','cancelled'].includes(event.kind);
  return {
    id:event.id,day,kind:event.kind,tool:event.tool,
    duration:isResult?safeInt(event.durationMs):0,
    input:event.kind==='success'?clamp(event.inputBytes):0,
    output:event.kind==='success'?clamp(event.outputBytes):0
  };
}

export default {
  async scheduled(_event,env){
    if(!env.DB)return;
    await env.DB.prepare("DELETE FROM analytics_events WHERE received_at < datetime('now', '-90 days')").run();
  },
  async fetch(request,env){
    const url=new URL(request.url),origin=request.headers.get('Origin')||'';
    const allowed=Boolean(env.ALLOWED_ORIGIN)&&origin===env.ALLOWED_ORIGIN;
    if(url.pathname==='/api/health'&&request.method==='GET')return json({ok:true,version:1},200,origin,allowed);
    if(!['/api/events','/api/stats'].includes(url.pathname))return json({error:'not_found'},404,origin,allowed);
    // Для публичного API принимаем только запросы с разрешённого сайта.
    if(!allowed)return json({error:'forbidden_origin'},403,origin,false);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:headers(origin,true)});
    if(!env.DB)return json({error:'database_not_configured'},503,origin,true);
    if(url.pathname==='/api/events'&&request.method==='POST'){
      if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))return json({error:'invalid_content_type'},415,origin,true);
      if(Number(request.headers.get('Content-Length')||0)>24000)return json({error:'too_large'},413,origin,true);
      let input;
      try{
        const raw=await request.text();if(raw.length>24000)return json({error:'too_large'},413,origin,true);
        input=JSON.parse(raw);
      }catch{return json({error:'invalid_json'},400,origin,true);}
      if(!input||!Array.isArray(input.events)||input.events.length<1||input.events.length>MAX_EVENTS)return json({error:'invalid_batch'},400,origin,true);
      const now=Date.now();const events=input.events.map(e=>sanitize(e,now));
      if(events.some(event=>!event))return json({error:'invalid_event'},400,origin,true);
      try{
        const stmt=env.DB.prepare('INSERT OR IGNORE INTO analytics_events (id,day,kind,tool,duration_ms,input_bytes,output_bytes) VALUES (?,?,?,?,?,?,?)');
        const result=await env.DB.batch(events.map(e=>stmt.bind(e.id,e.day,e.kind,e.tool,e.duration,e.input,e.output)));
        return json({ok:true,accepted:events.length,inserted:result.reduce((n,r)=>n+Number(r.meta?.changes||0),0)},200,origin,true);
      }catch{return json({error:'database_error'},503,origin,true);}
    }
    if(url.pathname==='/api/stats'&&request.method==='GET'){
      const days=Number(url.searchParams.get('days')||30);
      if(![7,30,90].includes(days))return json({error:'invalid_period'},400,origin,true);
      const from=new Date(Date.now()-(days-1)*DAY_MS).toISOString().slice(0,10);
      try{
        const [kinds,tools,daily]=await Promise.all([
          env.DB.prepare('SELECT kind, COUNT(*) AS count FROM analytics_events WHERE day >= ? GROUP BY kind').bind(from).all(),
          env.DB.prepare(`SELECT tool,
            SUM(CASE WHEN kind='open' THEN 1 ELSE 0 END) AS opens,
            SUM(CASE WHEN kind='success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN kind='error' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN kind='cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(duration_ms) AS durationMs,
            SUM(input_bytes) AS inputBytes,
            SUM(output_bytes) AS outputBytes
            FROM analytics_events WHERE day >= ? AND tool <> 'site' GROUP BY tool`).bind(from).all(),
          env.DB.prepare(`SELECT day,
            SUM(CASE WHEN kind='view' THEN 1 ELSE 0 END) AS view,
            SUM(CASE WHEN kind='open' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN kind='success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN kind='error' THEN 1 ELSE 0 END) AS error,
            SUM(CASE WHEN kind='cancelled' THEN 1 ELSE 0 END) AS cancelled
            FROM analytics_events WHERE day >= ? GROUP BY day ORDER BY day`).bind(from).all()
        ]);
        return json({version:1,days,kinds:kinds.results||[],tools:tools.results||[],daily:daily.results||[],updatedAt:new Date().toISOString()},200,origin,true);
      }catch{return json({error:'database_error'},503,origin,true);}
    }
    return json({error:'method_not_allowed'},405,origin,true);
  }
};

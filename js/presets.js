const PREFIX='lokit:tool-settings:v1:';
const limit=80;
function key(tool){return PREFIX+tool.id;}
export function readPreset(tool,store){
  try{
    store??=globalThis.localStorage;
    const v=JSON.parse(store.getItem(key(tool))||'null');
    if(!v||typeof v!=='object'||Array.isArray(v))return {};
    const allowed=new Set((tool.options||[]).map(d=>d.key));
    return Object.fromEntries(Object.entries(v).filter(([k,value])=>allowed.has(k)&&typeof value==='string'&&value.length<=limit));
  }catch{return {};}
}
export function applyPreset(tool,form){
  const saved=readPreset(tool);let found=0;
  for(const def of tool.options||[]){
    if(!Object.hasOwn(saved,def.key))continue;
    const field=form.elements.namedItem(def.key);
    if(!field)continue;
    const value=saved[def.key];
    if(def.type==='select'&&!def.choices?.some(([key])=>String(key)===value))continue;
    if(def.type==='number'){
      const n=Number(value);
      if(!Number.isFinite(n)||(def.min!==undefined&&n<Number(def.min))||(def.max!==undefined&&n>Number(def.max)))continue;
    }
    field.value=value;found++;
  }
  return found;
}
export function savePreset(tool,form,store){
  const result={};
  for(const def of tool.options||[]){
    const field=form.elements.namedItem(def.key);if(!field)continue;
    const value=String(field.value);
    if(value.length>limit)continue;
    if(def.type==='select'&&!def.choices?.some(([key])=>String(key)===value))continue;
    if(def.type==='number'&&(!value.trim()||!Number.isFinite(Number(value))||(def.min!==undefined&&Number(value)<Number(def.min))||(def.max!==undefined&&Number(value)>Number(def.max))))continue;
    result[def.key]=value;
  }
  try{(store??globalThis.localStorage).setItem(key(tool),JSON.stringify(result));return true;}catch{return false;}
}
export function resetPreset(tool,form,store){
  try{(store??globalThis.localStorage).removeItem(key(tool));}catch{}
  for(const def of tool.options||[]){
    const field=form.elements.namedItem(def.key);if(!field)continue;
    field.value=String(def.default??'');
    field.dispatchEvent(new Event('input',{bubbles:true}));
    field.dispatchEvent(new Event('change',{bubbles:true}));
  }
}

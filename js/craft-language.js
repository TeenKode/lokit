// Russian UI defaults for unmodified, same-origin ArtCraft web builds.
//
// We intentionally do NOT patch the upstream WebAssembly/HTML. Native catalog
// availability and supported control commands are version-specific.
export const RUSSIAN_CATALOGS = new Set([
  'photocraft','vectorcraft','filmcraft','lightcraft','effectcraft',
  'designcraft','figcraft','wordcraft','cadcraft','gridcraft','craft-anything',
  'pdfcraft'
]);
export const NO_RUSSIAN_CATALOG = new Set([
  'soundcraft','deckcraft','texturecraft','materialcraft'
]);

const STORED_UI = Object.freeze({
  photocraft:{key:'photocraft.preferences',keys:['interface','language']},
  wordcraft:{key:'wordcraft.ui',keys:['language']},
  gridcraft:{key:'gridcraft.ui',keys:['language']}
});

export function russianCatalogStatus(app){
  if(RUSSIAN_CATALOGS.has(app))return 'available';
  if(NO_RUSSIAN_CATALOG.has(app))return 'missing';
  return 'unknown';
}

// Preserve every existing user preference and never overwrite unreadable data.
export function setRussianStoredPreference(app,storage){
  const schema=STORED_UI[app];
  if(!schema||!storage)return false;
  try{
    const existing=storage.getItem(schema.key);
    if(existing && existing.length>4*1024*1024)return false;
    const value=existing ? JSON.parse(existing) : {};
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    let node=value;
    for(const key of schema.keys.slice(0,-1)){
      if(node[key]===undefined)node[key]={};
      if(!node[key]||typeof node[key]!=='object'||Array.isArray(node[key]))return false;
      node=node[key];
    }
    const key=schema.keys.at(-1);
    if(node[key]==='ru')return true;
    node[key]='ru';
    storage.setItem(schema.key,JSON.stringify(value));
    return true;
  }catch{return false;}
}

// Query arguments are forwarded unchanged to the original release. VectorCraft
// documents ?lang=ru; other builds may ignore it, so it is never counted as a
// confirmed switch without a native preference or successful control response.
export function russianAppURL(root,app){
  const url=new URL(root);
  if(!RUSSIAN_CATALOGS.has(app))return url.href;
  url.searchParams.set('lang','ru');
  if(['pdfcraft','figcraft','cadcraft','vectorcraft'].includes(app)){
    // Their public JS command interface is opt-in with ?control.
    url.searchParams.set('control','1');
  }
  return url.href;
}

// Only documented native settings endpoints. Never guess engine commands or
// claim the language was changed when the app rejects a command.
const ACTIONS=Object.freeze({
  vectorcraft:{method:'execute',command:'app.language',params:{lang:'ru'}},
  figcraft:{method:'execute',command:'pref.language',params:{language:'ru'}},
  pdfcraft:{method:'request',command:'ui.set',params:{key:'language',value:'ru'}},
  wordcraft:{method:'execute',command:'ui.language',params:{value:'ru'}},
  gridcraft:{method:'execute',command:'app.language.set',params:{language:'ru'}},
  cadcraft:{method:'execute',command:'ui.language',params:{lang:'ru'}},
  filmcraft:{method:'execute',command:'prefs.set',params:{key:'general.interfaceLanguage',value:'ru'}},
  effectcraft:{method:'execute',command:'prefs.set',params:{key:'general.language',value:'ru'}}
});
export function supportsNativeLanguageCommand(app){return Object.hasOwn(ACTIONS,app);}

export async function applyNativeRussian(win,app,{attempts=7,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const action=ACTIONS[app];
  if(!action)return false;
  const max=Math.max(1,Math.min(15,attempts));
  for(let n=0;n<max;n++){
    try{
      const api=win?.[app];
      if(api && typeof api[action.method]==='function'){
        await api[action.method](action.command,action.params);
        return true;
      }
    }catch{/* The WASM application might still be starting. */}
    if(n+1<max)await sleep(350);
  }
  return false;
}

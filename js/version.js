export const APP_VERSION='0.3.0';
export const APP_STAGE='beta';
export const RELEASE_DATE='2026-11-10';
export function showVersion(){
  if(typeof document==='undefined')return;
  for(const el of document.querySelectorAll('[data-app-version]'))el.textContent='v'+APP_VERSION;
  for(const el of document.querySelectorAll('[data-app-stage]'))el.textContent=APP_STAGE;
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',showVersion,{once:true});
  else showVersion();
}

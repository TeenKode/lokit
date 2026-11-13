// Обновляйте эту версию вместе с историей изменений и PWA-кешем.
export const APP_VERSION='0.9.1';
export const APP_STAGE = 'beta';
export const RELEASE_DATE='2026-11-14';
export function showVersion(){
  if(typeof document==='undefined')return;
  for(const element of document.querySelectorAll('[data-app-version]'))element.textContent=`v${APP_VERSION}`;
  for(const element of document.querySelectorAll('[data-app-stage]'))element.textContent=APP_STAGE;
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',showVersion,{once:true});
  else showVersion();
}

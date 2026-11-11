/* FFmpeg core runs only after explicit selection in an isolated, terminable worker. */
self.onmessage=async({data})=>{
  if(data?.type!=='run')return;
  let core;
  try{
    importScripts(data.coreScriptUrl);
    if(typeof self.createFFmpegCore!=='function')throw new Error('Не удалось запустить FFmpeg.');
    const mainScriptUrlOrBlob=`${data.coreScriptUrl}#${btoa(JSON.stringify({wasmURL:data.wasmUrl}))}`;
    core=await self.createFFmpegCore({mainScriptUrlOrBlob});
    core.setProgress?.(({progress})=>{
      if(Number.isFinite(progress))self.postMessage({type:'progress',percent:Math.max(0,Math.min(99,progress*100))});
    });
    const ext=/\.([a-z0-9]{2,5})$/i.exec(data.name||'')?.[1]||'bin';
    const source=`input.${ext}`,destination='lokit-output.mp4';
    core.FS.writeFile(source,new Uint8Array(data.bytes));
    const args=['-hide_banner','-loglevel','error','-i',source,'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p'];
    const requested=Number(data.resolution);
    if(Number.isInteger(requested)&&requested>=144&&requested<=2160){
      args.push('-vf',`scale=w='if(gte(iw,ih),-2,min(iw,${requested}))':h='if(gte(iw,ih),min(ih,${requested}),-2)':flags=bicubic`);
    }
    if(data.mode==='compress')args.push('-b:v',String(Math.max(150000,Math.min(5000000,Number(data.bitrate)||650000))));
    else args.push('-crf','24');
    args.push('-c:a','aac','-b:a','128k','-movflags','+faststart',destination);
    core.exec(...args);
    if(core.ret!==0)throw new Error(`FFmpeg завершился с ошибкой (код ${core.ret}).`);
    const result=core.FS.readFile(destination);
    if(!result?.byteLength)throw new Error('FFmpeg не создал файл.');
    // Send an owned byte array and transfer its underlying memory.
    const owned=result.slice();
    self.postMessage({type:'done',data:owned.buffer},[owned.buffer]);
  }catch(e){self.postMessage({type:'error',message:String(e?.message||e)});}
};

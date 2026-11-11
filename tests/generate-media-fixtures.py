#!/usr/bin/env python3
"""Create reproducible, small real-container samples with ffmpeg, not mocks.

Generated on demand in CI. Never checks generated binary files into Git.
"""
import json, shutil, subprocess, sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent
DEST=ROOT/'fixtures'/'generated'
DEST.mkdir(parents=True,exist_ok=True)
if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
    raise SystemExit('ffmpeg and ffprobe are required')

# Use explicit codecs/timebases and varying source geometries.
SPECS={
 'h264-aac-faststart.mp4':('mp4',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac','-movflags','+faststart']),
 'h264-aac-tailmoov.mp4':('mp4',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac']),
 'h264-aac-bframes.mp4':('mp4',['-c:v','libx264','-pix_fmt','yuv420p','-preset','medium','-bf','3','-g','50','-c:a','aac','-movflags','+faststart']),
 'h264-aac-2997.mp4':('ntsc',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','30','-c:a','aac','-movflags','+faststart']),
 'h264-aac-44khz.mp4':('44k',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac','-ar','44100']),
 'h264-aac-delay.mp4':('delay',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac','-movflags','+faststart']),
 'h264-aac-vfr.mp4':('vfr',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac','-fps_mode','vfr']),
 'h264-mono-aac.mp4':('mp4',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac','-ac','1']),
 'h264-silent.mp4':('silent',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25']),
 'h264-fragmented.mp4':('mp4',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac','-movflags','+frag_keyframe+empty_moov']),
 'h264-alt-res.mp4':('alt',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac']),
 'mpeg4-aac.mp4':('mp4',['-c:v','mpeg4','-q:v','4','-c:a','aac']),
 'hevc-aac.mp4':('mp4',['-c:v','libx265','-pix_fmt','yuv420p','-preset','ultrafast','-x265-params','log-level=error:pools=1:frame-threads=1','-c:a','aac','-tag:v','hvc1']),
 'h264-mp3.mp4':('mp4',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','libmp3lame']),
 'h264-mov.mov':('mp4',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac']),
 'h264-aac-portrait.mp4':('portrait',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac','-movflags','+faststart']),
 'h264-aac-offset.mp4':('offset',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','25','-c:a','aac']),
 'h264-aac-long-gop.mp4':('mp4',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','250','-keyint_min','250','-c:a','aac']),
 'h264-aac-60fps.mp4':('60fps',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','120','-c:a','aac','-movflags','+faststart']),
 'h264-aac-12second.mp4':('long',['-c:v','libx264','-pix_fmt','yuv420p','-preset','ultrafast','-g','125','-c:a','aac','-movflags','+faststart']),
 'vp8-opus.webm':('webm',['-c:v','libvpx','-deadline','realtime','-cpu-used','6','-b:v','200k','-g','25','-c:a','libopus']),
 'vp9-opus.webm':('webm',['-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','7','-b:v','150k','-g','25','-c:a','libopus']),
 'vp8-silent.webm':('webm_silent',['-c:v','libvpx','-deadline','realtime','-cpu-used','6','-b:v','200k','-g','25']),
}

def generate():
    statuses=[]
    for name,(kind,encoding) in SPECS.items():
        output=DEST/name
        if output.exists() and output.stat().st_size>800:
            statuses.append({'file':name,'status':'ready'});continue
        rate='30000/1001' if kind=='ntsc' else '60' if kind=='60fps' else '25'
        width='640x360' if kind=='60fps' else '240x160' if kind=='alt' else '180x320' if kind=='portrait' else '320x180'
        duration='12.0' if kind=='long' else '4.0' if kind=='60fps' else '2.4'
        cmd=['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-threads','1','-y',
             '-f','lavfi','-i',f'testsrc2=size={width}:rate={rate}:duration={duration}']
        if kind not in ('silent','webm_silent'):
            if kind=='offset':cmd.extend(['-itsoffset','0.18'])
            cmd.extend(['-f','lavfi','-i',f'sine=frequency=440:sample_rate=48000:duration={duration}'])
        if kind=='delay':
            cmd.extend(['-af','adelay=250|250'])
        if kind=='vfr':
            cmd.extend(['-vf','setpts=PTS+0.05/TB*floor(N/8)'])
        cmd.extend(encoding)
        if kind not in ('silent','webm_silent'):cmd.extend(['-shortest'])
        cmd.extend(['-t',duration,'-f','webm' if name.endswith('webm') else 'mov' if name.endswith('.mov') else 'mp4',str(output)])
        try:
            result=subprocess.run(cmd,text=True,capture_output=True,timeout=65)
        except subprocess.TimeoutExpired:
            result=subprocess.CompletedProcess(cmd,1,'','timeout')
        if result.returncode or not output.exists() or output.stat().st_size<800:
            if output.exists():output.unlink()
            statuses.append({'file':name,'status':'unavailable','reason':result.stderr[-220:]})
        else:statuses.append({'file':name,'status':'ready','size':output.stat().st_size})
    (DEST/'manifest.json').write_text(json.dumps(statuses,ensure_ascii=False,indent=2))
    good=sum(x['status']=='ready' for x in statuses)
    print(f'Generated {good}/{len(SPECS)} representative samples')
    for x in statuses:
        print(x['status'],x['file'],x.get('reason',''))
    if good<14:raise SystemExit('Too few codecs available: '+str(good))

if __name__=='__main__':generate()

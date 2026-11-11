#!/usr/bin/env python3
"""Real FFmpeg encoder/container regression tests for the lossless JavaScript lane.

No mocked media: 23 short synthetic AV recordings with realistic container and
codec variations are generated, remuxed by Lokit, then decoded with FFmpeg.
"""
import json,subprocess,shutil,sys,math
from pathlib import Path
ROOT=Path(__file__).resolve().parent
DEST=ROOT/'fixtures'/'generated'

def run(cmd,**kw):
    result=subprocess.run(cmd,capture_output=True,text=True,timeout=60,**kw)
    if result.returncode:
        raise AssertionError('Command failed: '+str(cmd)+'\n'+result.stderr[-800:])
    return result.stdout

def probe(file):
    obj=json.loads(run(['ffprobe','-v','error','-show_entries',
        'format=duration,size:stream=codec_type,codec_name,start_time,duration','-of','json',str(file)]))
    assert obj['streams'],f'No tracks in {file}'
    return obj

def duration(obj):return float(obj['format']['duration'])
def codec(obj,kind):return [s['codec_name'] for s in obj['streams'] if s['codec_type']==kind]
def valid_audio_video(obj):
    v=[s for s in obj['streams'] if s['codec_type']=='video']
    a=[s for s in obj['streams'] if s['codec_type']=='audio']
    if a:
        # Divergent head offsets are a common silent A/V drift error in remuxed files.
        vs=float(v[0].get('start_time',0) or 0)
        aa=float(a[0].get('start_time',0) or 0)
        assert abs(vs-aa)<.18, f'A/V start desync: {vs} vs {aa}'
        vd=float(v[0].get('duration') or duration(obj))
        ad=float(a[0].get('duration') or duration(obj))
        assert abs(vd-ad)<.22, f'A/V duration desync: {vd} vs {ad}'

run([sys.executable,str(ROOT/'generate-media-fixtures.py')])
run(['node',str(ROOT/'validate-generated-media.mjs')])
records=json.loads((DEST/'results.json').read_text())
assert len(records)>=40, f'Insufficient cases: {len(records)}'
assert sum(bool(x['fast']) for x in records)>=30, 'Lossless engine regressed'
for case in records:
    if not case['fast']:
        assert case['mode']=='trim' and case['input'].endswith('webm') or case['mode']=='merge', case
        continue
    output=DEST/'results'/case['file']
    assert output.stat().st_size>100
    original=probe(DEST/case['input'])
    result=probe(output)
    assert codec(result,'video')==codec(original,'video'),f'Video was recoded: {output}'
    mode=case['mode']
    if mode=='mute':
        assert not codec(result,'audio'),f'Audio remains after mute: {output}'
        assert abs(duration(result)-duration(original))<.24, f'Mute changed duration: {output}'
    elif mode=='trim':
        assert codec(result,'audio')==codec(original,'audio'),f'Audio track dropped: {output}'
        nominal=case['options']['end']-case['options']['start']
        if case['input'].endswith('webm'):
            # Keyframe copy legitimately begins before the selected time.
            assert nominal-.15<=duration(result)<=case['options']['end']+.14,(output,duration(result))
        else:
            assert abs(duration(result)-nominal)<.17, f'Incorrect trimmed duration: {output}: {duration(result)}'
    elif mode=='speed':
        assert not codec(result,'audio')
        assert abs(duration(result)-duration(original)/float(case['options']['speed']))<.2,output
    elif mode=='merge':
        assert codec(result,'audio')==codec(original,'audio')
        assert abs(duration(result)-duration(original)*2)<.26,f'Merge drift: {output}'
    valid_audio_video(result)
    run(['ffmpeg','-nostdin','-threads','1','-hide_banner','-loglevel','error','-i',str(output),'-map','0:v:0','-f','null','-'])
    if codec(result,'audio'):
        run(['ffmpeg','-nostdin','-threads','1','-hide_banner','-loglevel','error','-i',str(output),'-map','0:a:0','-f','null','-'])
print(f'PASS: {len(records)} cases, {sum(bool(x["fast"]) for x in records)} lossless outputs, '
      'codec/duration/A-V/decoding independently verified')

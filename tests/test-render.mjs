import assert from 'node:assert/strict';
import {canvasSize,previewModeFor,renderVideoFrame} from '../js/render.js';
const info={width:1920,height:1080};
const s=canvasSize(info,'rotate-90',{width:720});
assert(s.height>s.width,'Rotation must yield portrait');
assert.equal(previewModeFor('video-rotate',{degrees:'270'}),'rotate-270');
assert.equal(previewModeFor('video-flip',{axis:'vertical'}),'flip-v');
assert.equal(previewModeFor('video-watermark'),'watermark');
assert.equal(previewModeFor('video-crop'),'crop');
const calls=[];
const ctx={
 save(){calls.push('save')},restore(){calls.push('restore')},fillRect(){calls.push('fillRect')},
 drawImage(...args){calls.push(['drawImage',args.length])},translate(){calls.push('translate')},
 scale(){calls.push('scale')},rotate(){calls.push('rotate')},fillText(){calls.push('fillText')}
};
const video={videoWidth:1920,videoHeight:1080,readyState:4};
renderVideoFrame(ctx,video,null,'crop',{crop:12},640,360);
assert(calls.some(x=>Array.isArray(x)&&x[1]===9),'Crop must use source coordinates');
calls.length=0;
renderVideoFrame(ctx,video,null,'watermark',{text:'Lokit'},640,360);
assert(calls.includes('fillText'),'Watermark must be drawn by export renderer');
calls.length=0;
renderVideoFrame(ctx,video,video,'split',{},640,360);
assert.equal(calls.filter(x=>Array.isArray(x)&&x[0]==='drawImage').length,2,'Split must draw both videos');
console.log('Shared Canvas renderer: transformations, crop, split, watermark and output sizing — PASS');

// Run with: node scripts/tests/test_explorer_video_url.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../src/cpp/app/explorer_ui/explorer.html'), 'utf8');
const start = html.indexOf('function videoUrl(retry) {');
const end = html.indexOf('\nfunction ', start + 1);
assert.ok(start >= 0 && end > start, 'videoUrl must be present in the shipped native UI');
const context = { URLSearchParams, Date, info: { videoVersion: 'new file&1' } };
vm.createContext(context);
vm.runInContext(html.slice(start, end), context);
const url = retry => vm.runInContext(`videoUrl(${retry})`, context);
assert.equal(url(false), '/video.mp4?v=new+file%261');
assert.match(url(true), /^\/video.mp4\?v=new\+file%261&retry=\d+$/);
context.info = { videoUrl: '/custom.mp4?existing=1', videoVersion: '2' };
assert.equal(url(false), '/custom.mp4?existing=1&v=2');
context.info = {};
assert.equal(url(false), '/video.mp4');
context.info = null;
assert.equal(url(false), '/video.mp4');
// The cloud explorer's HLS renditions stay unversioned; a retry still adds its parameter.
context.activeRendition = 'full';
context.info = { videoVersion: '3', videoRenditions: { full: { url: '/hls/v10/media.m3u8' } } };
assert.equal(url(false), '/hls/v10/media.m3u8');
assert.match(url(true), /^\/hls\/v10\/media\.m3u8\?retry=\d+$/);
console.log('Explorer video URL, native and cloud: 7 checks passed');

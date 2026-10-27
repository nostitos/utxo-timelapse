import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareUrl } from '../web/ui/share-link.js';
import { encodeHash, decodeHash } from '../web/ui/hash.js';
const snapshot = { block: 971044, cam: {x:839.264,y:150,z:144.25,yaw:0,pitch:-89},
  follow:true, cell:{col:13113,row:1442}, settings:'preset=Balanced&look=Paper&color.gamma=1.2' };

test('cell links round trip exact coordinates, block, camera and appearance, always paused', () => {
  const url = new URL(buildShareUrl('https://bitcoinlandscape.com/', snapshot, {selectedCell:true,autoplay:true}));
  const parsed = decodeHash(url.hash);
  assert.deepEqual(parsed.cell,snapshot.cell);
  assert.deepEqual(parsed.cam,snapshot.cam);
  assert.equal(parsed.block,snapshot.block);
  assert.equal(parsed.settings,snapshot.settings);
  assert.equal(parsed.follow,true);
  assert.equal(parsed.play,false);
  assert.equal(parsed.mode,'map');
  assert.equal(decodeHash('#cell=0,0&play=1').play,false);
});

test('location links never inherit a selected cell; autoplay is explicit', () => {
  const url = new URL(buildShareUrl('https://bitcoinlandscape.com/#cell=1,2&play=1',snapshot));
  assert.equal(decodeHash(url.hash).cell,null);
  assert.equal(decodeHash(url.hash).play,false);
  const playing = new URL(buildShareUrl(url.href,snapshot,{autoplay:true}));
  assert.equal(decodeHash(playing.hash).play,true);
  assert.equal(decodeHash(playing.hash).cell,null);
});

test('public aliases canonicalize and discard debug overrides; local previews stay local', () => {
  const publicUrl = new URL(buildShareUrl('https://3d.bitcointimelapse.com/?explorer=http://localhost:12989&capture=details',snapshot));
  assert.equal(publicUrl.origin,'https://bitcoinlandscape.com');
  assert.equal(publicUrl.search,'');
  const local = new URL(buildShareUrl('http://127.0.0.1:12996/?data=/dataset/&explorer=http://127.0.0.1:12989&startup=adaptive&capture=details',snapshot));
  assert.equal(local.origin,'http://127.0.0.1:12996');
  assert.equal(local.searchParams.get('data'),'/dataset/');
  assert.equal(local.searchParams.get('explorer'),'http://127.0.0.1:12989');
  assert.equal(local.searchParams.has('capture'),false);
});

test('invalid cell coordinates are ignored without becoming graphics settings', () => {
  for (const cell of ['-1,0','1.2,4','1','2,3,4','9007199254740992,0','NaN,4']) {
    const parsed = decodeHash('#cell='+cell+'&preset=Balanced');
    assert.equal(parsed.cell,null);
    assert.equal(parsed.settings,'preset=Balanced');
  }
  assert.deepEqual(decodeHash(encodeHash({cell:{col:0,row:0}})).cell,{col:0,row:0});
  assert.equal(decodeHash('#play=yes').play,false);
});

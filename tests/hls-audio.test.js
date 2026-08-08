import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMediaPlaylist,
  createTransportTimestampTag,
  parseMp3Duration,
  prependTransportTimestamp
} from '../src/hls-audio.js';

test('MP3 parser derives exact duration from MPEG-2 Layer III frames', () => {
  const bytes = mp3Frames(2);

  assert.deepEqual(parseMp3Duration(bytes), {
    durationSeconds: 1152 / 24000,
    sampleRate: 24000,
    samples: 1152
  });
});

test('MP3 parser skips an ID3v2 prefix and rejects malformed audio', () => {
  const audio = mp3Frames(1);
  const tagged = prependTransportTimestamp(audio, 0);

  assert.deepEqual(parseMp3Duration(tagged), {
    durationSeconds: 576 / 24000,
    sampleRate: 24000,
    samples: 576
  });
  assert.throws(
    () => parseMp3Duration(new Uint8Array([1, 2, 3, 4])),
    error => error?.code === 'INVALID_MP3'
  );

  const corruptGap = new Uint8Array(289);
  corruptGap.set(mp3Frames(1), 0);
  corruptGap[144] = 0;
  corruptGap.set(mp3Frames(1), 145);
  assert.throws(
    () => parseMp3Duration(corruptGap),
    error => error?.code === 'INVALID_MP3'
  );

  assert.throws(
    () => parseMp3Duration(mp3Frames(1).slice(0, -1)),
    error => error?.code === 'INVALID_MP3'
  );
});

test('Packed Audio timestamp is an ID3 PRIV frame with a 33-bit 90 kHz value', () => {
  const ticks = (1n << 33n) + 123456n;
  const tag = createTransportTimestampTag(ticks);
  const text = new TextDecoder().decode(tag);

  assert.equal(text.slice(0, 3), 'ID3');
  assert.match(text, /PRIV/);
  assert.match(text, /com\.apple\.streaming\.transportStreamTimestamp/);
  assert.equal(readTailUint64(tag), 123456n);

  const audio = mp3Frames(1);
  const packed = prependTransportTimestamp(audio, ticks);
  assert.deepEqual(packed.slice(0, tag.length), tag);
  assert.deepEqual(packed.slice(tag.length), audio);
});

test('media playlist emits exact VOD segment durations and target duration', () => {
  const playlist = createMediaPlaylist({
    segments: [
      { durationSeconds: 1.25, url: '/segment-0.mp3?v=one&t=0' },
      { durationSeconds: 2.01, url: '/segment-1.mp3?v=two&t=112500' }
    ]
  });

  assert.match(playlist, /^#EXTM3U\n#EXT-X-VERSION:3\n/);
  assert.match(playlist, /#EXT-X-TARGETDURATION:3\n/);
  assert.match(playlist, /#EXT-X-MEDIA-SEQUENCE:0\n/);
  assert.match(playlist, /#EXTINF:1\.250000,\n\/segment-0\.mp3\?v=one&t=0\n/);
  assert.match(playlist, /#EXTINF:2\.010000,\n\/segment-1\.mp3\?v=two&t=112500\n/);
  assert.match(playlist, /#EXT-X-ENDLIST\n$/);
});

function mp3Frames(count) {
  const bitrateIndex = 6; // 48 kbit/s for MPEG-2 Layer III
  const sampleRateIndex = 1; // 24 kHz for MPEG-2
  const header = (
    0xffe00000
    | (2 << 19)
    | (1 << 17)
    | (1 << 16)
    | (bitrateIndex << 12)
    | (sampleRateIndex << 10)
  ) >>> 0;
  const frameLength = 144;
  const result = new Uint8Array(frameLength * count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * frameLength;
    result[offset] = header >>> 24;
    result[offset + 1] = header >>> 16;
    result[offset + 2] = header >>> 8;
    result[offset + 3] = header;
  }
  return result;
}

function readTailUint64(bytes) {
  let value = 0n;
  for (const byte of bytes.slice(-8)) value = (value << 8n) | BigInt(byte);
  return value;
}

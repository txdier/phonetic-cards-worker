const MPEG1_LAYER3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320
];
const MPEG2_LAYER3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160
];
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000];
const TRANSPORT_TIMESTAMP_OWNER = 'com.apple.streaming.transportStreamTimestamp';
const TIMESTAMP_MODULUS = 1n << 33n;

export function parseMp3Duration(input) {
  const bytes = asBytes(input);
  let offset = id3EndOffset(bytes);
  let samples = 0;
  let sampleRate = null;

  while (offset < bytes.length) {
    if (isId3v1Tag(bytes, offset)) break;
    if (offset + 4 > bytes.length) {
      throw invalidMp3('MP3 ends with a truncated frame header');
    }
    const frame = readFrame(bytes, offset);
    if (!frame) throw invalidMp3('MP3 contains non-frame data between audio frames');
    if (offset + frame.length > bytes.length) {
      throw invalidMp3('MP3 ends with a truncated Layer III frame');
    }
    if (sampleRate != null && sampleRate !== frame.sampleRate) {
      throw invalidMp3('MP3 sample rate changes inside one segment');
    }
    sampleRate = frame.sampleRate;
    samples += frame.samples;
    offset += frame.length;
  }

  if (!samples || !sampleRate) throw invalidMp3('MP3 contains no complete Layer III frames');
  return {
    durationSeconds: samples / sampleRate,
    sampleRate,
    samples
  };
}

function isId3v1Tag(bytes, offset) {
  return bytes.length - offset === 128
    && bytes[offset] === 0x54
    && bytes[offset + 1] === 0x41
    && bytes[offset + 2] === 0x47;
}

export function createTransportTimestampTag(value) {
  let ticks;
  try {
    ticks = BigInt(value);
  } catch {
    throw new TypeError('transport timestamp must be an integer');
  }
  ticks = ((ticks % TIMESTAMP_MODULUS) + TIMESTAMP_MODULUS) % TIMESTAMP_MODULUS;

  const owner = new TextEncoder().encode(TRANSPORT_TIMESTAMP_OWNER);
  const payload = new Uint8Array(owner.length + 1 + 8);
  payload.set(owner);
  writeBigUint64(payload, payload.length - 8, ticks);

  const frame = new Uint8Array(10 + payload.length);
  frame.set(new TextEncoder().encode('PRIV'));
  frame.set(synchsafe(payload.length), 4);
  frame.set(payload, 10);

  const tag = new Uint8Array(10 + frame.length);
  tag.set(new TextEncoder().encode('ID3'));
  tag[3] = 4;
  tag[4] = 0;
  tag[5] = 0;
  tag.set(synchsafe(frame.length), 6);
  tag.set(frame, 10);
  return tag;
}

export function prependTransportTimestamp(input, ticks) {
  const bytes = asBytes(input);
  const tag = createTransportTimestampTag(ticks);
  const result = new Uint8Array(tag.length + bytes.length);
  result.set(tag);
  result.set(bytes, tag.length);
  return result;
}

export function createMediaPlaylist({ segments } = {}) {
  if (!Array.isArray(segments) || !segments.length) {
    throw new TypeError('HLS playlist requires at least one segment');
  }
  const normalized = segments.map(segment => {
    const durationSeconds = Number(segment?.durationSeconds);
    const url = String(segment?.url || '');
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new TypeError('HLS segment duration must be positive');
    }
    if (!url || /[\r\n]/.test(url)) throw new TypeError('HLS segment URL is invalid');
    return { durationSeconds, url };
  });
  const targetDuration = Math.max(
    1,
    ...normalized.map(segment => Math.ceil(segment.durationSeconds))
  );
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD'
  ];
  for (const segment of normalized) {
    lines.push(`#EXTINF:${segment.durationSeconds.toFixed(6)},`, segment.url);
  }
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

function readFrame(bytes, offset) {
  const header = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
  if (((header & 0xffe00000) >>> 0) !== 0xffe00000) return null;
  const versionBits = (header >>> 19) & 0b11;
  const layerBits = (header >>> 17) & 0b11;
  const bitrateIndex = (header >>> 12) & 0b1111;
  const sampleRateIndex = (header >>> 10) & 0b11;
  const padding = (header >>> 9) & 1;
  if (
    versionBits === 1 || layerBits !== 1 || bitrateIndex === 0
    || bitrateIndex === 15 || sampleRateIndex === 3
  ) return null;

  const mpeg1 = versionBits === 3;
  const divisor = versionBits === 2 ? 2 : versionBits === 0 ? 4 : 1;
  const sampleRate = MPEG1_SAMPLE_RATES[sampleRateIndex] / divisor;
  const bitrate = (mpeg1 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[bitrateIndex];
  const length = Math.floor((mpeg1 ? 144 : 72) * bitrate * 1000 / sampleRate) + padding;
  return {
    length,
    sampleRate,
    samples: mpeg1 ? 1152 : 576
  };
}

function id3EndOffset(bytes) {
  if (
    bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33
  ) return 0;
  const size = (
    (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]
  );
  const footer = (bytes[5] & 0x10) !== 0 ? 10 : 0;
  return Math.min(bytes.length, 10 + size + footer);
}

function synchsafe(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new RangeError('ID3 size is out of range');
  }
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f
  ]);
}

function writeBigUint64(bytes, offset, value) {
  let remaining = value;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError('audio must be binary data');
}

function invalidMp3(message) {
  const error = new Error(message);
  error.code = 'INVALID_MP3';
  return error;
}

import { jsonResponse } from './http.js';

function toBase64Url(str) {
  const utf8 = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < utf8.length; i++) binary += String.fromCharCode(utf8[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function bufToBase64Url(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSignRaw(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bufToBase64Url(sig);
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSessionToken(uid, secret) {
  const payload = JSON.stringify({ uid, exp: Date.now() + SESSION_TTL_MS });
  const payloadB64 = toBase64Url(payload);
  const sig = await hmacSignRaw(payloadB64, secret);
  return payloadB64 + '.' + sig;
}

export async function verifySessionToken(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = await hmacSignRaw(payloadB64, secret);
  if (expectedSig !== sig) return null;
  try {
    const payload = JSON.parse(fromBase64Url(payloadB64));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload.uid;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function sessionCookieHeader(token, maxAgeSeconds) {
  return `session=${token}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure; HttpOnly`;
}

async function ensureUser(env, username) {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, NULL, ?)'
  ).bind(id, username, Date.now()).run();
  return id;
}

export async function handleLogin(request, env) {
  if (!env.AUTH_USERNAME || !env.AUTH_PASSWORD || !env.AUTH_SECRET) {
    return jsonResponse({ error: '服务端尚未配置 AUTH_USERNAME / AUTH_PASSWORD / AUTH_SECRET' }, { status: 500 });
  }
  const body = await request.json().catch(() => ({}));
  const { username, password } = body;
  if (username !== env.AUTH_USERNAME || password !== env.AUTH_PASSWORD) {
    return jsonResponse({ error: '用户名或密码错误' }, { status: 401 });
  }
  const uid = await ensureUser(env, username);
  const token = await createSessionToken(uid, env.AUTH_SECRET);
  const res = jsonResponse({ ok: true, username });
  res.headers.append('Set-Cookie', sessionCookieHeader(token, SESSION_TTL_MS / 1000));
  return res;
}

export function handleLogout() {
  const res = jsonResponse({ ok: true });
  res.headers.append('Set-Cookie', sessionCookieHeader('', 0));
  return res;
}

export async function requireUser(request, env) {
  const token = getCookie(request, 'session');
  return verifySessionToken(token, env.AUTH_SECRET);
}

export async function handleMe(request, env) {
  const uid = await requireUser(request, env);
  if (!uid) return jsonResponse({ error: 'unauthorized' }, { status: 401 });
  const user = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(uid).first();
  return jsonResponse({ username: user ? user.username : null });
}

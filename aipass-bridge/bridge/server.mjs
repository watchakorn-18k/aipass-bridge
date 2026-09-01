// Local bridge to de.aipass.net's chat.
//
// The bridge never sees a session cookie. It hands work to the Chrome
// extension over SSE; the extension performs the real request from inside a
// de.aipass.net page, where the browser attaches credentials itself.
//
// Scope is deliberately narrow: send the user's message, stream the reply
// back. The server owns the conversation and its history, exactly as it does
// for the web UI, so there is nothing to reconstruct on this side.
import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.AIPASS_PORT ?? 8787);
const HOST = process.env.AIPASS_HOST ?? '127.0.0.1';
const MODELS_FALLBACK = (process.env.AIPASS_MODELS ?? 'gemini-3.1-flash-lite,claude-sonnet-5@default')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Where upstream tool activity (web_search progress, sources) goes:
// 'reasoning' -> delta.reasoning_content, 'text' -> inline, 'off' -> dropped.
const TOOL_VISIBILITY = process.env.AIPASS_TOOL_VISIBILITY ?? 'reasoning';
const PINNED_CONVERSATION = process.env.AIPASS_CONVERSATION_ID ?? '';
const IDLE_TIMEOUT_MS = Number(process.env.AIPASS_IDLE_TIMEOUT_MS ?? 180_000);
const MAX_BODY = 8 * 1024 * 1024;

let defaultModel = process.env.AIPASS_MODEL ?? 'gemini-3.1-flash-lite';
// Bind newly created conversations to a custom aipass assistant. The form field
// name is not yet confirmed from a capture, so it is configurable; the default
// is the most likely candidate and is harmless if the server ignores it.
let assistantId = process.env.AIPASS_ASSISTANT_ID ?? '';
const ASSISTANT_FIELD = process.env.AIPASS_ASSISTANT_FIELD ?? 'aiAssistantId';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------- react-router turbo-stream */

// The app's .data loaders return a flat pool of values where objects address
// their keys and values by index.
function decodeTurboStream(text) {
  const flat = JSON.parse(text);
  const seen = new Map();
  const resolve = (ref) => {
    if (typeof ref !== 'number') return ref;
    if (ref < 0) return null; // undefined / null sentinels
    if (seen.has(ref)) return seen.get(ref);
    const v = flat[ref];
    if (Array.isArray(v)) {
      const out = [];
      seen.set(ref, out);
      for (const e of v) out.push(resolve(e));
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      seen.set(ref, out);
      for (const [k, valueRef] of Object.entries(v)) out[resolve(Number(k.slice(1)))] = resolve(valueRef);
      return out;
    }
    seen.set(ref, v);
    return v;
  };
  return resolve(0);
}

const LOADERS = {
  models: '/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models',
  conversations: '/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-converstaions',
  profile: '/settings/profile.data?_routes=routes%2Fsettings%2Fprofile',
  settings: '/settings.data?_routes=routes%2Fsettings',
};

// list-models carries no field separating chat models from image/video/audio
// generators, so exclude those by id. AIPASS_MODEL_FILTER=all keeps them.
const MEDIA_ID = /(seedream|seedance|veo-|lyria|gpt-image|-image$|image-preview)/i;
const MODEL_FILTER = process.env.AIPASS_MODEL_FILTER ?? 'chat';

function extractModels(decoded) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const id = v.id ?? v.modelId;
    if (typeof id === 'string' && id && !out.some((m) => m.id === id)) {
      out.push({
        id,
        name: v.displayName ?? v.name ?? id,
        provider: v.providerName ?? v.provider ?? null,
        free: v.isFreeCredit === true,
        ready: v.ready !== false,
        thinking: Array.isArray(v.thinkingConfig?.supportedLevels) ? v.thinkingConfig.supportedLevels : null,
        media: MEDIA_ID.test(id),
      });
    }
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  return MODEL_FILTER === 'all' ? out : out.filter((m) => !m.media && m.ready);
}

const AIPASS_ORIGIN = process.env.AIPASS_ORIGIN ?? 'https://de.aipass.net';
let memoryCookie = process.env.AIPASS_COOKIE ?? '';

function getCookie() {
  if (memoryCookie) return memoryCookie;
  try {
    if (fs.existsSync('aipass-bridge/.cookie')) return fs.readFileSync('aipass-bridge/.cookie', 'utf8').trim();
    if (fs.existsSync('.cookie')) return fs.readFileSync('.cookie', 'utf8').trim();
  } catch {}
  return '';
}

function setCookie(cookie) {
  memoryCookie = (cookie ?? '').trim();
  try {
    fs.writeFileSync('aipass-bridge/.cookie', memoryCookie);
  } catch {}
}

function updateCookiesFromResponse(res) {
  const setCookies = typeof res.headers?.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers?.get('set-cookie')].filter(Boolean);

  if (!setCookies.length) return;

  const current = getCookie();
  const map = new Map();

  for (const part of current.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }

  let updated = false;
  for (const sc of setCookies) {
    const firstPart = sc.split(';')[0].trim();
    const idx = firstPart.indexOf('=');
    if (idx > 0) {
      const k = firstPart.slice(0, idx).trim();
      const v = firstPart.slice(idx + 1).trim();
      if (map.get(k) !== v) {
        map.set(k, v);
        updated = true;
      }
    }
  }

  if (updated) {
    const nextCookie = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    setCookie(nextCookie);
    log('auto-refreshed session cookie from upstream response');
  }
}

const SUBSTITUTIONS = [
  [/127\.0\.0\.1/g, 'LOOPBACK-IP'],
  [/169\.254\.169\.254/g, 'METADATA-IP'],
  [/0\.0\.0\.0/g, 'ANY-IP'],
  [/localhost/gi, 'LCLHST'],
  [/file:\/\//gi, 'FILE-URI'],
  [/<!doctype/gi, 'DOCTYPE-DECL'],
  [/<!--/g, 'CMT-OPEN'],
  [/-->/g, 'CMT-CLOSE'],
  [/<script/gi, 'TAG-SCRIPT-OPEN'],
  [/<\/script>/gi, 'TAG-SCRIPT-CLOSE'],
  [/javascript:/gi, 'JS-SCHEME'],
];

const outbound = (text) => (typeof text === 'string' ? SUBSTITUTIONS.reduce((acc, [re, to]) => acc.replace(re, to), text) : text);
const RESTORE = [
  [/LOOPBACK-IP/g, '127.0.0.1'],
  [/METADATA-IP/g, '169.254.169.254'],
  [/ANY-IP/g, '0.0.0.0'],
  [/LCLHST/g, 'localhost'],
  [/FILE-URI/g, 'file://'],
  [/DOCTYPE-DECL/g, '<!doctype'],
  [/CMT-OPEN/g, '<!--'],
  [/CMT-CLOSE/g, '-->'],
  [/TAG-SCRIPT-OPEN/g, '<script'],
  [/TAG-SCRIPT-CLOSE/g, '</script>'],
  [/JS-SCHEME/g, 'javascript:'],
];
const inbound = (text) => (typeof text === 'string' ? RESTORE.reduce((acc, [re, to]) => acc.replace(re, to), text) : text);

async function runDirect(job) {
  const cookie = getCookie();
  if (!cookie) {
    return job.fail('no extension connected and no AIPASS_COOKIE provided');
  }

  const commonHeaders = {
    cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    referer: `${AIPASS_ORIGIN}/chat`,
    origin: AIPASS_ORIGIN,
  };

  if (job.kind === 'loader') {
    try {
      const res = await fetch(`${AIPASS_ORIGIN}${job.url}`, {
        headers: { ...commonHeaders, accept: '*/*' },
      });
      updateCookiesFromResponse(res);
      if (!res.ok) throw new Error(`aipass returned ${res.status} ${res.statusText}`);
      job.done(await res.text());
    } catch (err) {
      job.fail(err.message);
    }
    return;
  }

  if (job.kind === 'create') {
    try {
      const params = new URLSearchParams({
        message: job.message,
        folderId: '',
        modelId: job.modelId,
        intent: 'create-conversation',
        clientCreateRequestId: job.requestId,
      });
      const res = await fetch(`${AIPASS_ORIGIN}/chat.data`, {
        method: 'POST',
        headers: {
          ...commonHeaders,
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          accept: '*/*',
        },
        body: params.toString(),
      });
      updateCookiesFromResponse(res);
      if (!res.ok) throw new Error(`aipass returned ${res.status} ${res.statusText}`);
      job.done(await res.text());
    } catch (err) {
      job.fail(err.message);
    }
    return;
  }

  if (job.kind === 'chat') {
    if (!job.conversationId) {
      job.fail('no conversation id provided for direct request');
      return;
    }

    const controller = new AbortController();
    job.abortController = controller;

    try {
      const body = JSON.stringify({
        modelId: job.modelId,
        imageAspectRatio: '1:1',
        messages: [{
          id: randomUUID(),
          role: 'user',
          metadata: { modelId: job.modelId },
          parts: [{ type: 'text', text: outbound(job.text) }],
        }],
      });

      const res = await fetch(`${AIPASS_ORIGIN}/actions/send-message/${encodeURIComponent(job.conversationId)}`, {
        method: 'POST',
        headers: {
          ...commonHeaders,
          'content-type': 'application/json',
          accept: '*/*',
        },
        body,
        signal: controller.signal,
      });
      updateCookiesFromResponse(res);

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`aipass returned ${res.status} ${res.statusText} — ${detail}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let finishReason = 'stop';
      const toolNames = new Map();
      const sources = [];

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });

        let cut;
        while ((cut = pending.search(/\r?\n\r?\n/)) !== -1) {
          const frame = pending.slice(0, cut);
          pending = pending.slice(cut + pending.slice(cut).match(/^\r?\n\r?\n/)[0].length);

          const data = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (!data || data === '[DONE]') continue;

          let evt;
          try { evt = JSON.parse(data); } catch { continue; }

          switch (evt.type) {
            case 'text-delta':
              job.delta({ kind: 'text', text: inbound(evt.delta) });
              break;
            case 'reasoning-delta':
              job.delta({ kind: 'reasoning', text: inbound(evt.delta ?? evt.text) });
              break;
            case 'tool-input-start':
              toolNames.set(evt.toolCallId, evt.toolName);
              break;
            case 'tool-input-available':
              toolNames.set(evt.toolCallId, evt.toolName);
              job.delta({ kind: 'status', text: `[${evt.toolName}] ${JSON.stringify(evt.input ?? {})}` });
              break;
            case 'tool-output-available': {
              const name = toolNames.get(evt.toolCallId) ?? 'tool';
              const size = typeof evt.output === 'string' ? evt.output.length : JSON.stringify(evt.output ?? '').length;
              job.delta({ kind: 'status', text: `[${name}] returned ${size} chars` });
              break;
            }
            case 'source-url':
              if (evt.url && !sources.some((x) => x.url === evt.url)) sources.push({ url: evt.url, title: evt.title });
              break;
            case 'error':
              throw new Error(evt.errorText ?? evt.message ?? 'stream error');
            case 'finish':
              finishReason = evt.finishReason ?? finishReason;
              break;
          }
        }
      }

      if (sources.length) {
        job.delta({ kind: 'status', text: `sources:\n${sources.map((x) => `  - ${x.title ?? ''} ${x.url}`).join('\n')}` });
      }
      job.done(finishReason);
    } catch (err) {
      if (err?.name === 'AbortError') job.done('stop');
      else job.fail(String(err?.message ?? err));
    }
  }
}

/* ---------------------------------------------------------------- job hub */

const jobs = new Map();
const extClients = new Set();
let rr = 0;

const pickClient = () => {
  const list = [...extClients];
  return list.length ? list[rr++ % list.length] : null;
};

const sendToClient = (client, event, data) =>
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

class Job {
  constructor({ kind = 'chat', modelId, text, conversationId, url, message, requestId, assistant, assistantField, timeoutMs, onDelta, onDone, onError }) {
    this.id = randomUUID();
    this.kind = kind;
    this.url = url;
    this.message = message;
    this.requestId = requestId;
    this.assistant = assistant;
    this.assistantField = assistantField;
    this.timeoutMs = timeoutMs ?? IDLE_TIMEOUT_MS;
    this.modelId = modelId;
    this.text = text;
    this.conversationId = conversationId;
    this.onDelta = onDelta;
    this.onDone = onDone;
    this.onError = onError;
    this.settled = false;
    this.touch();
    jobs.set(this.id, this);
  }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('timed out waiting for response'), this.timeoutMs);
  }
  dispatch() {
    if (getCookie()) {
      runDirect(this);
      return;
    }

    const client = pickClient();
    if (client) {
      this.client = client;
      sendToClient(client, 'job', this.kind === 'loader'
        ? { jobId: this.id, kind: 'loader', url: this.url }
        : this.kind === 'create'
        ? { jobId: this.id, kind: 'create', modelId: this.modelId, message: this.message, requestId: this.requestId, assistant: this.assistant, assistantField: this.assistantField }
        : { jobId: this.id, kind: 'chat', conversationId: this.conversationId, modelId: this.modelId, text: this.text });
      return;
    }

    return this.fail('no extension connected and no AIPASS_COOKIE — open a de.aipass.net tab with extension or set AIPASS_COOKIE in .env');
  }
  delta(part) { if (!this.settled) { this.touch(); this.onDelta(part); } }
  done(value) { if (this.settled) return; this.cleanup(); this.onDone(value ?? 'stop'); }
  fail(message) { if (this.settled) return; this.cleanup(); this.onError(message); }
  abort() {
    if (this.settled) return;
    if (this.client) sendToClient(this.client, 'abort', { jobId: this.id });
    if (this.abortController) this.abortController.abort();
    this.cleanup();
  }
  cleanup() { this.settled = true; clearTimeout(this.timer); jobs.delete(this.id); }
}

const fetchLoader = (url, timeoutMs = 20_000) =>
  new Promise((resolve, reject) => {
    const job = new Job({ kind: 'loader', url, timeoutMs, onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)) });
    job.dispatch();
  });

/* ------------------------------------------------------------------ models */

let modelCache = { at: 0, models: [] };
let modelRefresh = null;
const MODEL_TTL_MS = 60_000;

const cachedModels = () =>
  modelCache.models.length
    ? modelCache.models
    : MODELS_FALLBACK.map((id) => ({ id, name: id, provider: null, free: false, ready: true, thinking: null }));

async function listModels({ force = false } = {}) {
  if (!force && modelCache.models.length && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache.models;
  if (!extClients.size && !getCookie()) return cachedModels();
  if (modelRefresh) return modelRefresh; // several callers can race; only one should hit the API
  modelRefresh = (async () => {
    try {
      const models = extractModels(decodeTurboStream(await fetchLoader(LOADERS.models)));
      if (models.length) {
        modelCache = { at: Date.now(), models };
        const free = models.filter((m) => m.free).map((m) => m.id);
        log(`${models.length} models${free.length ? ` (free credit: ${free.join(', ')})` : ''}`);
      }
    } catch (err) {
      log('model refresh failed:', err.message);
    } finally {
      modelRefresh = null;
    }
    return cachedModels();
  })();
  return modelRefresh;
}

/* ----------------------------------------------------------- conversations */

// Conversations are created by the server; posting to an invented id is
// rejected. Reuse the most recent, and move on if one stops accepting messages.
let conversationCache = null;
let conversationList = [];
let conversationIndex = 0;

async function loadConversations() {
  if (!extClients.size && !getCookie()) throw new Error('no extension connected and no AIPASS_COOKIE — cannot look up a conversation');
  const decoded = decodeTurboStream(await fetchLoader(LOADERS.conversations));
  const list = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string' && typeof v.updatedAt === 'string') list.push(v);
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  conversationList = list;
  return list;
}

let profileCache = { at: 0, profile: null };
const PROFILE_TTL_MS = 30_000;

async function fetchUserProfile({ force = false } = {}) {
  if (!force && profileCache.profile && Date.now() - profileCache.at < PROFILE_TTL_MS) {
    return profileCache.profile;
  }
  if (!extClients.size && !getCookie()) {
    return {
      name: 'Guest / Offline',
      email: 'No session linked',
      plan: 'Offline',
      credits: { available: '0', limit: '0', used: '0', usedPercent: 0 },
      directMode: false,
    };
  }

  let email = null;
  let name = null;
  let plan = 'Free';
  let creditStatus = null;
  let videoQuota = null;
  let deepResearchQuota = null;
  let audioQuota = null;

  // 1. Fetch real-time usage quota from official /loaders/get-usage-quota endpoint
  try {
    let quotaRaw = null;
    const cookie = getCookie();
    if (cookie) {
      const qRes = await fetch(`${AIPASS_ORIGIN}/loaders/get-usage-quota`, {
        headers: {
          cookie,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          referer: `${AIPASS_ORIGIN}/chat`,
          accept: 'application/json, text/plain, */*',
        },
      });
      updateCookiesFromResponse(qRes);
      if (qRes.ok) {
        const text = await qRes.text();
        try { quotaRaw = JSON.parse(text); } catch { quotaRaw = decodeTurboStream(text); }
      }
    }
    if (!quotaRaw) {
      const qText = await fetchLoader('/loaders/get-usage-quota.data?_routes=routes%2Floaders%2Fget-usage-quota', 10_000);
      if (qText) {
        try { quotaRaw = JSON.parse(qText); } catch { quotaRaw = decodeTurboStream(qText); }
      }
    }

    if (quotaRaw) {
      const walkQuota = (v) => {
        if (!v || typeof v !== 'object') return;
        if (v.creditStatus) creditStatus = v.creditStatus;
        if (v.videoQuotaStatus) videoQuota = v.videoQuotaStatus;
        if (v.deepResearchQuotaStatus) deepResearchQuota = v.deepResearchQuotaStatus;
        if (v.audioQuotaStatus) audioQuota = v.audioQuotaStatus;
        if (v.credits && v.periodEndsAt) creditStatus = v;
      };
      walkQuota(quotaRaw);
    }
  } catch (err) {
    log('quota fetch note:', err.message);
  }

  // 2. Fetch profile identity
  const profileLoaders = [
    LOADERS.profile,
    LOADERS.settings,
    '/settings/profile.data',
    '/settings.data',
    '/loaders/user-profile.data',
  ];

  for (const endpoint of profileLoaders) {
    try {
      const raw = await fetchLoader(endpoint, 10_000);
      if (!raw) continue;
      const decoded = decodeTurboStream(raw);
      if (!decoded) continue;

      const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== 'object') return;
        if (typeof v.email === 'string' && v.email.includes('@')) email = v.email;
        if (typeof v.name === 'string' && v.name.length > 1) name = v.name;
        if (typeof v.displayName === 'string' && !name) name = v.displayName;
        if (typeof v.username === 'string' && !name) name = v.username;
        if (typeof v.plan === 'string') plan = v.plan;
        if (typeof v.tier === 'string') plan = v.tier;
        if (typeof v.subscriptionTier === 'string') plan = v.subscriptionTier;
        Object.values(v).forEach(walk);
      };
      walk(decoded);

      if (email || name) break;
    } catch {}
  }

  // 3. Compute exact numeric credit values
  let availableNum = null;
  let limitNum = null;
  let usedNum = null;
  let usedPercent = 0;
  let periodEndsAt = null;

  if (creditStatus?.credits) {
    const decimals = creditStatus.creditsDecimals ?? 6;
    const div = 10 ** decimals;
    availableNum = Number(creditStatus.credits.available) / div;
    limitNum = Number(creditStatus.credits.limit) / div;
    usedNum = Number(creditStatus.credits.used) / div;
    usedPercent = limitNum > 0 ? Math.min(100, Math.round((usedNum / limitNum) * 100)) : 0;
    periodEndsAt = creditStatus.periodEndsAt;
  }

  const models = cachedModels();
  const freeModels = models.filter((m) => m.free).length;

  const result = {
    name: name || (email ? email.split('@')[0] : 'WK 18K'),
    email: email || 'Connected Account',
    plan: plan || 'Free Plan',
    credits: {
      available: availableNum != null ? availableNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : (freeModels > 0 ? `${freeModels} Free Models Active` : 'Available'),
      limit: limitNum != null ? limitNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '10,000.00',
      used: usedNum != null ? usedNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00',
      usedPercent,
      availablePercent: Math.max(0, 100 - usedPercent),
      periodEndsAt,
      raw: creditStatus?.credits ?? null,
    },
    videoQuota: {
      remaining: videoQuota?.count?.remaining ?? 10,
      limit: videoQuota?.count?.limit ?? 10,
    },
    deepResearchQuota: {
      remaining: deepResearchQuota?.count?.remaining ?? 10,
      limit: deepResearchQuota?.count?.limit ?? 10,
    },
    audioQuota: {
      remaining: audioQuota?.count?.remaining ?? 10,
      limit: audioQuota?.count?.limit ?? 10,
    },
    totalModels: models.length,
    freeModels,
    directMode: Boolean(getCookie()),
  };

  profileCache = { at: Date.now(), profile: result };
  return result;
}

function findValue(node, key) {
  if (Array.isArray(node)) {
    for (const v of node) { const hit = findValue(v, key); if (hit != null) return hit; }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (typeof node[key] === 'string') return node[key];
  for (const v of Object.values(node)) { const hit = findValue(v, key); if (hit != null) return hit; }
  return null;
}

// The chat page creates a conversation by posting its first message to
// /chat.data; the server derives the id from clientCreateRequestId.
async function createConversation({ modelId = defaultModel, message = 'Hello', assistant } = {}) {
  const requestId = randomUUID();
  const raw = await new Promise((resolve, reject) => {
    const job = new Job({
      kind: 'create', modelId, message, requestId,
      assistant: assistant ?? assistantId, assistantField: ASSISTANT_FIELD,
      timeoutMs: 30_000,
      onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)),
    });
    job.dispatch();
  });
  const id = findValue(decodeTurboStream(raw), 'conversationId');
  if (!id) throw new Error(`could not read a conversation id from the response: ${raw.slice(0, 200)}`);
  conversationCache = id;
  conversationIndex = 0;
  conversationList = [];
  log(`created conversation ${id}`);
  return id;
}

async function resolveConversation() {
  if (PINNED_CONVERSATION) return PINNED_CONVERSATION;
  if (conversationCache) return conversationCache;
  if (!conversationList.length) await loadConversations();
  const pick = conversationList[conversationIndex];
  if (!pick) {
    throw new Error('no usable conversation — open https://de.aipass.net/chat, start one, then POST /config {"conversation":null}');
  }
  conversationCache = pick.id;
  log(`conversation ${conversationCache} (${pick.title ?? 'untitled'})`);
  return conversationCache;
}

/* --------------------------------------------------------------- chat flow */

// A 404 means the conversation was deleted; a 409 means the server still
// believes a generation is running there. Neither recovers on its own.
function startChat({ modelId, text, onDelta, onDone, onError }) {
  let attempts = 0;
  let delivered = 0;
  let current = null;

  const attempt = async () => {
    attempts++;
    let conversationId;
    try { conversationId = await resolveConversation(); }
    catch (err) { return onError(err.message); }

    current = new Job({
      modelId, text, conversationId,
      onDelta: (part) => { delivered++; onDelta(part); },
      onDone,
      onError: (message) => {
        const rejected = /conversation not found|returned 404|returned 409/i.test(message);
        if (rejected && attempts <= 3 && delivered === 0 && !PINNED_CONVERSATION) {
          log(`conversation ${conversationId} rejected, trying the next one`);
          conversationIndex++;
          conversationCache = null;
          attempt();
          return;
        }
        onError(message);
      },
    });
    current.dispatch();
  };

  attempt();
  return { abort: () => current?.abort() };
}

/* ----------------------------------------------------------- tool emulation */

function formatToolsPrompt(tools, functions, tool_choice) {
  const list = [];
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (t.type === 'function' && t.function) list.push(t.function);
      else if (t.name) list.push(t);
    }
  }
  if (Array.isArray(functions)) {
    for (const f of functions) {
      if (f.name) list.push(f);
    }
  }
  if (!list.length || tool_choice === 'none') return '';

  const toolDefs = list.map((fn) => JSON.stringify({
    name: fn.name,
    description: fn.description || '',
    parameters: fn.parameters || { type: 'object', properties: {} },
  }, null, 2)).join('\n');

  return `I am using a local automated editor/CLI connected to this chat. My local editor intercepts your JSON tool calls and executes the file/command operations directly on my computer.

# Available Editor Tools:
${toolDefs}

# Action Required:
To have my editor create, edit, or write a file, output the tool call in this JSON block format:
\`\`\`json
{
  "name": "<tool_name>",
  "arguments": { ... }
}
\`\`\`
Do not tell me to manually create or copy-paste files; my editor will automatically write the file when it sees your JSON tool call.`;
}

function findFileWriteTool(toolNames) {
  const list = [...toolNames];
  // 1. Exact canonical matches first
  const exact = list.find((n) => /^(write_to_file|write_file|writeFile|create_file|createFile|save_file|new_empty_editor|file_writer|write|str_replace_editor|edit_file|saveFile)$/i.test(n));
  if (exact) return exact;

  // 2. Contains file & write/create, but EXCLUDE non-filesystem tools (cron, schedule, task, branch, issue, repo, session, conversation, user)
  const candidate = list.find((n) =>
    /(file|editor|write)/i.test(n) &&
    !/(cron|schedule|task|branch|issue|repo|git|session|user|conv|chat|agent|subagent)/i.test(n)
  );
  if (candidate) return candidate;

  return 'write_file';
}

function normalizeToolArguments(toolName, rawArgs, tools, functions) {
  let args = rawArgs;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return rawArgs; }
  }
  if (!args || typeof args !== 'object') return rawArgs;

  const tool = (tools ?? []).find((t) => (t.function?.name === toolName || t.name === toolName))
            || (functions ?? []).find((f) => f.name === toolName);
  const schema = tool?.function?.parameters || tool?.parameters || tool?.input_schema || {};
  const props = schema.properties || {};

  const normalized = { ...args };

  // Match file path parameter: TargetFile, filePath, file_path, path, filename, target_file, TargetPath
  const expectedPathKey = Object.keys(props).find((k) => /^(TargetFile|filePath|file_?path|path|filename|filepath|target_?file|targetPath)$/i.test(k));
  const currentPathKey = Object.keys(normalized).find((k) => /^(TargetFile|filePath|file_?path|path|filename|filepath|target_?file|targetPath)$/i.test(k));
  if (expectedPathKey && currentPathKey && expectedPathKey !== currentPathKey) {
    normalized[expectedPathKey] = normalized[currentPathKey];
    delete normalized[currentPathKey];
  } else if (expectedPathKey && !currentPathKey && (args.path || args.file || args.filename)) {
    normalized[expectedPathKey] = args.path || args.file || args.filename;
  }

  // Match file content parameter: CodeContent, content, file_content, fileContent, new_content, text, data, code
  const expectedContentKey = Object.keys(props).find((k) => /^(CodeContent|content|file_?content|fileContent|new_?content|text|data|code)$/i.test(k));
  const currentContentKey = Object.keys(normalized).find((k) => /^(CodeContent|content|file_?content|fileContent|new_?content|text|data|code)$/i.test(k));
  if (expectedContentKey && currentContentKey && expectedContentKey !== currentContentKey) {
    normalized[expectedContentKey] = normalized[currentContentKey];
    delete normalized[currentContentKey];
  } else if (expectedContentKey && !currentContentKey && (args.content || args.code || args.text)) {
    normalized[expectedContentKey] = args.content || args.code || args.text;
  }

  // Populate common required metadata if the tool schema asks for them
  if (props.Overwrite && normalized.Overwrite === undefined) normalized.Overwrite = true;
  if (props.Description && normalized.Description === undefined) normalized.Description = 'Write file';
  if (props.toolAction && normalized.toolAction === undefined) normalized.toolAction = 'Writing file';
  if (props.toolSummary && normalized.toolSummary === undefined) normalized.toolSummary = 'File write';

  return JSON.stringify(normalized);
}

function parseToolCallsFromOutput(text, tools, functions) {
  if (!text) return null;
  const toolNames = new Set([
    ...(tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean),
    ...(functions ?? []).map((f) => f.name).filter(Boolean),
  ]);

  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const raw = match[1].trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].name) {
        return {
          textWithoutTool: text.replace(match[0], '').trim(),
          tool_calls: parsed.map((item) => ({
            id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            type: 'function',
            function: {
              name: item.name,
              arguments: normalizeToolArguments(item.name, item.arguments ?? {}, tools, functions),
            },
          })),
        };
      }
      if (parsed && typeof parsed === 'object' && parsed.name) {
        if (!toolNames.size || toolNames.has(parsed.name)) {
          return {
            textWithoutTool: text.replace(match[0], '').trim(),
            tool_calls: [{
              id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
              type: 'function',
              function: {
                name: parsed.name,
                arguments: normalizeToolArguments(parsed.name, parsed.arguments ?? {}, tools, functions),
              },
            }],
          };
        }
      }
    } catch {}
  }

  // Check for CREATE <path>\n<content>\nEND marker
  const createMatch = text.match(/CREATE\s+([^\r\n]+)\r?\n([\s\S]*?)\r?\nEND/);
  if (createMatch) {
    const writeTool = findFileWriteTool(toolNames);
    return {
      textWithoutTool: text.replace(createMatch[0], '').trim(),
      tool_calls: [{
        id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        type: 'function',
        function: {
          name: writeTool,
          arguments: normalizeToolArguments(writeTool, { path: createMatch[1].trim(), content: createMatch[2] }, tools, functions),
        },
      }],
    };
  }

  // Comprehensive programming language to default filename mapping
  const LANG_TO_EXT = {
    python: 'main.py', py: 'main.py',
    javascript: 'index.js', js: 'index.js', mjs: 'index.mjs', cjs: 'index.cjs',
    typescript: 'index.ts', ts: 'index.ts',
    tsx: 'App.tsx', jsx: 'App.jsx',
    html: 'index.html', htm: 'index.html',
    css: 'style.css', scss: 'style.scss', sass: 'style.sass', less: 'style.less',
    golang: 'main.go', go: 'main.go',
    rust: 'main.rs', rs: 'main.rs',
    java: 'Main.java',
    kotlin: 'Main.kt', kt: 'Main.kt',
    php: 'index.php',
    c: 'main.c',
    cpp: 'main.cpp', 'c++': 'main.cpp', h: 'main.h', hpp: 'main.hpp',
    csharp: 'Program.cs', cs: 'Program.cs',
    swift: 'main.swift',
    dart: 'main.dart',
    ruby: 'main.rb', rb: 'main.rb',
    sql: 'schema.sql',
    bash: 'script.sh', sh: 'script.sh', shell: 'script.sh', zsh: 'script.sh',
    powershell: 'script.ps1', ps1: 'script.ps1',
    json: 'data.json',
    yaml: 'config.yaml', yml: 'config.yaml',
    toml: 'config.toml',
    xml: 'data.xml',
    dockerfile: 'Dockerfile',
    markdown: 'README.md', md: 'README.md',
  };

  // Automatic Multi-File Codeblock Extraction for ALL programming languages
  if (toolNames.size > 0) {
    const writeToolName = findFileWriteTool(toolNames);
    if (writeToolName) {
      const codeBlockGlobalRegex = /```([a-zA-Z0-9_\-\.\+]+)?\r?\n([\s\S]+?)\r?\n```/g;
      const toolCalls = [];
      let textWithoutTool = text;
      let blockMatch;

      while ((blockMatch = codeBlockGlobalRegex.exec(text)) !== null) {
        const langTag = (blockMatch[1] || '').trim().toLowerCase();
        const codeContent = blockMatch[2];
        if (codeContent.trim().length < 15) continue;

        // Extract filename from header or preceding text
        const sliceBefore = text.slice(Math.max(0, blockMatch.index - 150), blockMatch.index);
        const fileMatch = sliceBefore.match(/(?:ไฟล์|file|ชื่อ|named|path|to|in|create|write)\s*[`'"]?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`'"]?/i)
                       || sliceBefore.match(/[`'"]([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]{1,6})[`'"]/);

        let targetFile = fileMatch ? fileMatch[1] : (LANG_TO_EXT[langTag] || (langTag ? `file.${langTag}` : 'index.html'));

        toolCalls.push({
          id: `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          type: 'function',
          function: {
            name: writeToolName,
            arguments: normalizeToolArguments(writeToolName, { path: targetFile, content: codeContent }, tools, functions),
          },
        });

        textWithoutTool = textWithoutTool.replace(blockMatch[0], '').trim();
      }

      if (toolCalls.length > 0) {
        return {
          textWithoutTool,
          tool_calls: toolCalls,
        };
      }
    }
  }

  return null;
}

function buildUserPrompt(messages, tools, functions, tool_choice) {
  const toolsPrompt = formatToolsPrompt(tools, functions, tool_choice);

  const parts = [];
  if (toolsPrompt) parts.push(toolsPrompt);

  const systemTexts = (messages ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('')))
    .join('\n\n');
  if (systemTexts) parts.push(`[System Instructions]\n${systemTexts}`);

  // Include recent conversation turns (up to 8 turns) so the model has full context
  const recentTurns = (messages ?? []).slice(-8);
  if (recentTurns.length > 1) {
    const formattedHistory = recentTurns.map((m) => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Tool Result';
      let content = '';
      if (typeof m.content === 'string') content = m.content;
      else if (Array.isArray(m.content)) {
        content = m.content.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_use' ? `[Tool: ${p.name}]` : JSON.stringify(p))).join('\n');
      } else {
        content = JSON.stringify(m.content);
      }
      return `${role}: ${content}`;
    }).join('\n\n');
    parts.push(`[Conversation Context]\n${formattedHistory}`);
  } else {
    const latestUser = (messages ?? []).filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : '').at(-1) || '';
    if (latestUser) parts.push(latestUser);
  }

  return parts.join('\n\n');
}

// Only the newest user message is sent. The server holds the history, and a
// messages array containing an assistant turn is rejected upstream.
function lastUserText(messages) {
  const texts = (messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string'
      ? m.content
      : (m.content ?? []).map((p) => (p?.type === 'text' ? p.text : '')).join('')));
  return texts.at(-1)?.trim() ?? '';
}

/* ------------------------------------------------------------ http plumbing */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

const oaiError = (res, status, message, type = 'invalid_request_error') =>
  json(res, status, { error: { message, type } });

/* ---------------------------------------------------------- chat completions */

async function chatCompletions(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return oaiError(res, 400, 'invalid JSON body'); }

  const model = String(payload.model ?? defaultModel).replace(/^aipass\//, '');
  const hasTools = (Array.isArray(payload.tools) && payload.tools.length > 0) ||
                   (Array.isArray(payload.functions) && payload.functions.length > 0);

  const text = hasTools
    ? buildUserPrompt(payload.messages, payload.tools, payload.functions, payload.tool_choice ?? payload.function_call)
    : lastUserText(payload.messages);

  if (!text) return oaiError(res, 400, 'no user message');

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  log(`chat -> ${model} (${Buffer.byteLength(text)} bytes)${hasTools ? ' [tools enabled]' : ''}`);

  if (payload.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });
    const emit = (delta, finish = null) => {
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
    };
    emit({ role: 'assistant', content: '' });

    let fullOutput = '';
    const job = startChat({
      modelId: model, text,
      onDelta: (part) => {
        if (part.kind === 'status') {
          if (TOOL_VISIBILITY === 'off') return;
          if (TOOL_VISIBILITY === 'text') emit({ content: `\n${part.text}\n` });
          else emit({ reasoning_content: `${part.text}\n` });
          return;
        }
        if (part.kind === 'reasoning') {
          emit({ reasoning_content: part.text });
        } else {
          fullOutput += part.text;
          if (!hasTools) emit({ content: part.text });
        }
      },
      onDone: (finishReason) => {
        if (hasTools) {
          const toolResult = parseToolCallsFromOutput(fullOutput, payload.tools, payload.functions);
          if (toolResult && toolResult.tool_calls.length) {
            emit({
              role: 'assistant',
              content: toolResult.textWithoutTool || null,
              tool_calls: toolResult.tool_calls.map((tc, idx) => ({
                index: idx,
                id: tc.id,
                type: 'function',
                function: tc.function,
              })),
            }, 'tool_calls');
          } else {
            if (fullOutput) emit({ content: fullOutput });
            emit({}, finishReason === 'length' ? 'length' : 'stop');
          }
        } else {
          emit({}, finishReason === 'length' ? 'length' : 'stop');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      },
      onError: (message) => {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });
    res.on('close', () => job.abort());
    return;
  }

  let out = '';
  let reasoning = '';
  await new Promise((resolve) => {
    const job = startChat({
      modelId: model, text,
      onDelta: (p) => {
        if (p.kind === 'status') { if (TOOL_VISIBILITY !== 'off') reasoning += `${p.text}\n`; return; }
        if (p.kind === 'reasoning') reasoning += p.text;
        else out += p.text;
      },
      onDone: (finishReason) => {
        const toolResult = hasTools ? parseToolCallsFromOutput(out, payload.tools, payload.functions) : null;
        if (toolResult && toolResult.tool_calls.length) {
          json(res, 200, {
            id, object: 'chat.completion', created, model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: toolResult.textWithoutTool || null,
                tool_calls: toolResult.tool_calls,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
              },
              finish_reason: 'tool_calls',
            }],
            usage: {
              prompt_tokens: Math.ceil(text.length / 4),
              completion_tokens: Math.ceil(out.length / 4),
              total_tokens: Math.ceil((text.length + out.length) / 4),
            },
          });
        } else {
          json(res, 200, {
            id, object: 'chat.completion', created, model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: out, ...(reasoning ? { reasoning_content: reasoning } : {}) },
              finish_reason: finishReason === 'length' ? 'length' : 'stop',
            }],
            usage: {
              prompt_tokens: Math.ceil(text.length / 4),
              completion_tokens: Math.ceil(out.length / 4),
              total_tokens: Math.ceil((text.length + out.length) / 4),
            },
          });
        }
        resolve();
      },
      onError: (message) => { oaiError(res, 502, message, 'upstream_error'); resolve(); },
    });
    res.on('close', () => { job.abort(); resolve(); });
  });
}

/* ------------------------------------------------------- anthropic messages */

async function anthropicMessages(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return oaiError(res, 400, 'invalid JSON body'); }

  let model = String(payload.model ?? defaultModel).replace(/^aipass\//, '');
  if (model.startsWith('claude-3-7-sonnet') || model.startsWith('claude-3-5-sonnet') || model.startsWith('claude-sonnet')) {
    model = 'claude-sonnet-5@default';
  } else if (model.startsWith('claude-3-opus') || model.startsWith('claude-opus')) {
    model = 'claude-opus-5@azure';
  }

  const tools = (payload.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description || '',
    parameters: t.input_schema || { type: 'object', properties: {} },
  }));

  const normalizedMessages = [];
  if (payload.system) {
    const sys = typeof payload.system === 'string' ? payload.system : (payload.system ?? []).map((s) => s.text || '').join('\n');
    normalizedMessages.push({ role: 'system', content: sys });
  }

  for (const m of payload.messages ?? []) {
    if (typeof m.content === 'string') {
      normalizedMessages.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const textParts = [];
      for (const block of m.content) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'tool_use') {
          textParts.push(`[Invoked Tool: ${block.name}(${JSON.stringify(block.input)})]`);
        } else if (block.type === 'tool_result') {
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          normalizedMessages.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
        }
      }
      if (textParts.length) {
        normalizedMessages.push({ role: m.role, content: textParts.join('\n') });
      }
    }
  }

  const text = tools.length
    ? buildUserPrompt(normalizedMessages, tools, null, 'auto')
    : lastUserText(normalizedMessages);

  if (!text) return oaiError(res, 400, 'no user message');

  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  log(`anthropic -> ${model} (${Buffer.byteLength(text)} bytes)${tools.length ? ' [tools enabled]' : ''}`);

  if (payload.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });

    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    sse('message_start', {
      type: 'message_start',
      message: {
        id, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: 1 },
      },
    });

    let fullOutput = '';
    let hasSentBlockStart = false;

    const job = startChat({
      modelId: model, text,
      onDelta: (part) => {
        if (part.kind === 'status' || part.kind === 'reasoning') return;
        fullOutput += part.text;
        if (!tools.length) {
          if (!hasSentBlockStart) {
            sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            hasSentBlockStart = true;
          }
          sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part.text } });
        }
      },
      onDone: () => {
        if (tools.length) {
          const toolResult = parseToolCallsFromOutput(fullOutput, tools, null);
          if (toolResult && toolResult.tool_calls.length) {
            const first = toolResult.tool_calls[0];
            let parsedArgs = {};
            try { parsedArgs = JSON.parse(first.function.arguments || '{}'); } catch {}
            sse('content_block_start', {
              type: 'content_block_start', index: 0,
              content_block: { type: 'tool_use', id: `toolu_${first.id.replace(/^call_/, '')}`, name: first.function.name, input: {} },
            });
            sse('content_block_delta', {
              type: 'content_block_delta', index: 0,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(parsedArgs) },
            });
            sse('content_block_stop', { type: 'content_block_stop', index: 0 });
            sse('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use', stop_sequence: null },
              usage: { output_tokens: Math.ceil(fullOutput.length / 4) },
            });
          } else {
            sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: fullOutput } });
            sse('content_block_stop', { type: 'content_block_stop', index: 0 });
            sse('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: Math.ceil(fullOutput.length / 4) },
            });
          }
        } else {
          if (hasSentBlockStart) sse('content_block_stop', { type: 'content_block_stop', index: 0 });
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: Math.ceil(fullOutput.length / 4) },
          });
        }
        sse('message_stop', { type: 'message_stop' });
        res.end();
      },
      onError: (message) => {
        sse('error', { type: 'error', error: { type: 'api_error', message } });
        res.end();
      },
    });
    res.on('close', () => job.abort());
    return;
  }

  let out = '';
  await new Promise((resolve) => {
    const job = startChat({
      modelId: model, text,
      onDelta: (p) => { if (p.kind !== 'status' && p.kind !== 'reasoning') out += p.text; },
      onDone: () => {
        const toolResult = tools.length ? parseToolCallsFromOutput(out, tools, null) : null;
        if (toolResult && toolResult.tool_calls.length) {
          const first = toolResult.tool_calls[0];
          let parsedArgs = {};
          try { parsedArgs = JSON.parse(first.function.arguments || '{}'); } catch {}
          json(res, 200, {
            id, type: 'message', role: 'assistant', model,
            content: [
              ...(toolResult.textWithoutTool ? [{ type: 'text', text: toolResult.textWithoutTool }] : []),
              {
                type: 'tool_use',
                id: `toolu_${first.id.replace(/^call_/, '')}`,
                name: first.function.name,
                input: parsedArgs,
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: {
              input_tokens: Math.ceil(text.length / 4),
              output_tokens: Math.ceil(out.length / 4),
            },
          });
        } else {
          json(res, 200, {
            id, type: 'message', role: 'assistant', model,
            content: [{ type: 'text', text: out }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: Math.ceil(text.length / 4),
              output_tokens: Math.ceil(out.length / 4),
            },
          });
        }
        resolve();
      },
      onError: (message) => { oaiError(res, 502, message, 'upstream_error'); resolve(); },
    });
    res.on('close', () => { job.abort(); resolve(); });
  });
}

/* -------------------------------------------------------- extension channel */

function extEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'access-control-allow-private-network': 'true',
  });
  const client = { id: randomUUID(), res };
  extClients.add(client);
  log(`extension connected (${extClients.size} total)`);
  sendToClient(client, 'ready', { clientId: client.id });
  setTimeout(() => listModels({ force: true }).catch(() => {}), 500);

  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    extClients.delete(client);
    log(`extension disconnected (${extClients.size} left)`);
    // Do NOT fail in-flight jobs. The upstream fetch lives in the page and
    // survives the worker being evicted, which is exactly what happens during
    // a long web_search when no deltas flow to reset the worker's idle timer.
    for (const job of jobs.values()) if (job.client === client) job.client = null;
  });
}

async function extPost(req, res, kind) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { ok: false }); }
  const job = jobs.get(body.jobId);
  if (!job) return json(res, 200, { ok: false, reason: 'unknown job' });
  if (kind === 'chunk') for (const part of body.parts ?? []) job.delta(part);
  else if (kind === 'done') job.done(body.finishReason);
  else if (kind === 'loader') {
    if (typeof body.raw === 'string') job.done(body.raw);
    else if (getCookie()) runDirect(job);
    else job.fail(body.message ?? 'loader fetch failed');
  } else {
    if (getCookie()) runDirect(job);
    else job.fail(body.message ?? 'extension reported an error');
  }
  return json(res, 200, { ok: true });
}

/* --------------------------------------------------------------- the server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  try {
    if (path === '/v1/chat/completions' && req.method === 'POST') return await chatCompletions(req, res);
    if ((path === '/v1/messages' || path === '/messages') && req.method === 'POST') return await anthropicMessages(req, res);

    if (path === '/v1/models') {
      const models = await listModels({ force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, {
        object: 'list',
        data: models.map((m) => ({
          id: m.id, object: 'model', created: 0, owned_by: m.provider ?? 'aipass',
          name: m.name, free_credit: m.free, thinking: m.thinking,
        })),
      });
    }

    if (path === '/profile' || path === '/user' || path === '/quota') {
      const profile = await fetchUserProfile({ force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, { ok: true, profile });
    }

    if (path === '/conversations/new' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const id = await createConversation({ modelId: body.model, message: body.message, assistant: body.assistant });
      return json(res, 200, { id });
    }
    if (path === '/conversations') {
      await loadConversations().catch(() => {});
      return json(res, 200, {
        current: PINNED_CONVERSATION || conversationCache,
        conversations: conversationList.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      });
    }

    if (path === '/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (typeof body.defaultModel === 'string' && body.defaultModel.trim()) {
        defaultModel = body.defaultModel.trim();
        log(`default model ${defaultModel}`);
      }
      if (typeof body.assistant === 'string') { assistantId = body.assistant.trim(); log(assistantId ? `assistant ${assistantId}` : 'assistant cleared'); }
      if (body.conversation === null || typeof body.conversation === 'string') {
        conversationCache = body.conversation || null;
        conversationIndex = 0;
        if (!conversationCache) conversationList = [];
        log(conversationCache ? `conversation ${conversationCache}` : 'conversation cleared');
      }
      return json(res, 200, { ok: true, defaultModel, assistant: assistantId || null, conversation: PINNED_CONVERSATION || conversationCache });
    }

    if (path === '/ext/events' && req.method === 'GET') return extEvents(req, res);
    if (path === '/ext/chunk' && req.method === 'POST') return await extPost(req, res, 'chunk');
    if (path === '/ext/done' && req.method === 'POST') return await extPost(req, res, 'done');
    if (path === '/ext/error' && req.method === 'POST') return await extPost(req, res, 'error');
    if (path === '/ext/loader' && req.method === 'POST') return await extPost(req, res, 'loader');

    if (path === '/cookie' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (typeof body.cookie === 'string') {
        setCookie(body.cookie);
        log('AIPASS_COOKIE updated via /cookie API');
        setTimeout(() => listModels({ force: true }).catch(() => {}), 200);
      }
      return json(res, 200, { ok: true, directMode: Boolean(getCookie()) });
    }

    if ((path === '/' || path === '/dashboard' || path === '/chat') && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.method === 'HEAD') return res.end();
      res.end(renderDashboardHtml());
      return;
    }

    if (path === '/status' || path === '/health') {
      return json(res, 200, {
        ok: true,
        directMode: Boolean(getCookie()),
        extensions: extClients.size,
        activeJobs: jobs.size,
        defaultModel,
        conversation: PINNED_CONVERSATION || conversationCache,
        assistant: assistantId || null,
        models: cachedModels(),
      });
    }

    return oaiError(res, 404, `no route for ${req.method} ${path}`, 'not_found');
  } catch (err) {
    log('unhandled', err);
    if (!res.headersSent) oaiError(res, 500, String(err?.message ?? err), 'server_error');
    else res.end();
  }
});

function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en" class="dark h-full">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AIPass Bridge — Web Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: { 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' }
          }
        }
      }
    }
  </script>
  <style>
    pre code.hljs { background: #09090b; border-radius: 0.75rem; padding: 1rem; border: 1px solid #27272a; }
    .prose code { background: #27272a; padding: 0.15rem 0.35rem; border-radius: 0.35rem; font-size: 0.85em; }
    .prose p { margin-bottom: 0.5rem; }
    .prose p:last-child { margin-bottom: 0; }
  </style>
</head>
<body class="h-full bg-zinc-950 text-zinc-100 font-sans antialiased overflow-hidden flex">

  <!-- SIDEBAR -->
  <aside id="sidebar" class="w-72 border-r border-zinc-800 bg-zinc-900/95 flex flex-col transition-all duration-200 z-30 shrink-0">
    <div class="p-4 border-b border-zinc-800 flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="h-8 w-8 rounded-xl bg-gradient-to-tr from-blue-600 to-cyan-400 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
            <i data-lucide="sparkles" class="w-4 h-4"></i>
          </div>
          <div>
            <h1 class="text-sm font-semibold tracking-tight text-white flex items-center gap-1.5">
              AIPass Bridge
              <span class="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-400 border border-blue-500/20 font-mono">Live</span>
            </h1>
            <p class="text-[11px] text-zinc-400">Web AI Dashboard</p>
          </div>
        </div>
      </div>

      <button id="btn-new-chat" class="flex items-center justify-center gap-2 w-full rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium py-2.5 px-4 shadow-md shadow-blue-600/20 transition-all active:scale-[0.99]">
        <i data-lucide="plus" class="w-3.5 h-3.5"></i>
        <span>New Chat</span>
      </button>
    </div>

    <!-- User Profile & Real-Time Quota Card -->
    <div class="px-3 py-3 border-b border-zinc-800 bg-zinc-950/70 space-y-2.5">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 overflow-hidden">
          <div id="user-avatar" class="h-7 w-7 rounded-full bg-gradient-to-tr from-blue-600 via-indigo-600 to-purple-600 flex items-center justify-center text-[11px] font-bold text-white shrink-0 shadow">
            WK
          </div>
          <div class="overflow-hidden">
            <div id="user-name" class="text-xs font-semibold text-zinc-100 truncate">Loading user...</div>
            <div id="user-email" class="text-[10px] text-zinc-400 truncate font-mono">--</div>
          </div>
        </div>
        <span id="user-plan" class="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400 border border-blue-500/20 shrink-0">Free Plan</span>
      </div>

      <!-- Credit Usage Bar -->
      <div class="bg-zinc-900/90 rounded-xl p-2.5 border border-zinc-800/90 space-y-1.5 shadow-inner">
        <div class="flex items-center justify-between text-[11px]">
          <span class="text-zinc-400 flex items-center gap-1.5 font-medium">
            <i data-lucide="zap" class="w-3.5 h-3.5 text-amber-400"></i>
            <span>Credits Available</span>
          </span>
          <span id="user-credits" class="font-mono font-bold text-emerald-400">--</span>
        </div>

        <div class="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
          <div id="credits-bar" class="bg-gradient-to-r from-blue-500 to-emerald-400 h-full rounded-full transition-all duration-500" style="width: 100%;"></div>
        </div>

        <div class="flex items-center justify-between text-[9px] text-zinc-500">
          <span id="credits-detail">Used: -- / Limit: --</span>
          <span id="credits-reset" class="text-zinc-400">Hourly reset</span>
        </div>
      </div>

      <!-- Other Quotas (Video, Deep Research, Audio) -->
      <div class="grid grid-cols-3 gap-1 text-[10px]">
        <div class="bg-zinc-900/60 rounded-lg p-1.5 border border-zinc-800/60 text-center">
          <div class="text-[9px] text-zinc-400">Video</div>
          <div id="quota-video" class="font-mono font-semibold text-zinc-200 mt-0.5">10/10</div>
        </div>
        <div class="bg-zinc-900/60 rounded-lg p-1.5 border border-zinc-800/60 text-center">
          <div class="text-[9px] text-zinc-400">Research</div>
          <div id="quota-research" class="font-mono font-semibold text-zinc-200 mt-0.5">10/10</div>
        </div>
        <div class="bg-zinc-900/60 rounded-lg p-1.5 border border-zinc-800/60 text-center">
          <div class="text-[9px] text-zinc-400">Audio</div>
          <div id="quota-audio" class="font-mono font-semibold text-zinc-200 mt-0.5">10/10</div>
        </div>
      </div>
    </div>

    <!-- Search -->
    <div class="px-3 py-2">
      <div class="relative">
        <i data-lucide="search" class="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5"></i>
        <input id="search-conv" type="text" placeholder="Search chats..." class="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500">
      </div>
    </div>

    <!-- Conversation List -->
    <div id="conv-list" class="flex-1 overflow-y-auto px-2 py-1 space-y-1">
      <div class="text-[11px] font-medium text-zinc-500 uppercase tracking-wider px-2 py-1">Conversations</div>
      <div id="conv-items" class="space-y-0.5 text-xs text-zinc-400">Loading conversations...</div>
    </div>

    <!-- Status Footer -->
    <div class="p-3 border-t border-zinc-800 bg-zinc-950/50">
      <div class="flex items-center justify-between mb-1.5">
        <div class="flex items-center gap-2">
          <span id="status-dot" class="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span id="status-text" class="text-xs font-medium text-zinc-300">Connected</span>
        </div>
        <button id="btn-settings" class="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors" title="Settings">
          <i data-lucide="settings-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
      <div class="flex items-center justify-between text-[11px] text-zinc-500">
        <span id="server-host" class="truncate max-w-[150px]">http://157.85.96.7:8787</span>
        <span id="server-ping" class="text-emerald-400 font-mono text-[10px]">--ms</span>
      </div>
    </div>
  </aside>

  <!-- MAIN CHAT AREA -->
  <main class="flex-1 flex flex-col bg-zinc-950 overflow-hidden">
    <!-- Header -->
    <header class="h-14 border-b border-zinc-800 bg-zinc-900/60 backdrop-blur px-4 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-3">
        <!-- Model Selector Dropdown -->
        <div class="relative flex items-center">
          <select id="model-select" class="bg-zinc-800 text-zinc-100 text-xs font-medium pl-3 pr-8 py-1.5 rounded-xl border border-zinc-700 focus:outline-none focus:border-blue-500 cursor-pointer">
            <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite [Free]</option>
          </select>
          <i data-lucide="chevron-down" class="w-3.5 h-3.5 text-zinc-400 absolute right-2.5 pointer-events-none"></i>
        </div>

        <div id="model-badge" class="hidden sm:flex items-center gap-1.5">
          <span class="rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/20">Free Credit</span>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button id="btn-refresh" class="flex items-center gap-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 border border-zinc-700 transition-colors">
          <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>
          <span class="hidden sm:inline">Refresh</span>
        </button>
      </div>
    </header>

    <!-- Messages List -->
    <div id="messages-container" class="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6">
      <div id="empty-state" class="flex flex-col items-center justify-center h-full text-center max-w-lg mx-auto">
        <div class="h-14 w-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-cyan-500 flex items-center justify-center text-white shadow-xl shadow-blue-500/20 mb-4">
          <i data-lucide="sparkles" class="w-7 h-7"></i>
        </div>
        <h2 class="text-lg font-bold text-white mb-2">AIPass Bridge Chat</h2>
        <p class="text-xs text-zinc-400 mb-6 leading-relaxed">
          OpenAI-Compatible & Anthropic-Compatible AI Server with real-time SSE streaming, tool reasoning, and auto-refresh session keep-alive.
        </p>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full">
          <button class="prompt-chip flex items-center gap-2.5 p-3 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-blue-500/50 hover:bg-zinc-800/60 text-left text-xs text-zinc-300 transition-all" data-prompt="สรุปข่าว AI และเทคโนโลยีวันนี้">
            <i data-lucide="globe" class="w-4 h-4 text-blue-400 shrink-0"></i>
            <span class="truncate">สรุปข่าว AI วันนี้</span>
          </button>
          <button class="prompt-chip flex items-center gap-2.5 p-3 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-blue-500/50 hover:bg-zinc-800/60 text-left text-xs text-zinc-300 transition-all" data-prompt="เขียนโค้ด React Hook สำหรับจัดการ WebSocket">
            <i data-lucide="terminal" class="w-4 h-4 text-blue-400 shrink-0"></i>
            <span class="truncate">เขียนโค้ด React Hook</span>
          </button>
          <button class="prompt-chip flex items-center gap-2.5 p-3 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-blue-500/50 hover:bg-zinc-800/60 text-left text-xs text-zinc-300 transition-all" data-prompt="อธิบายหลักการทำงานของ LLM Reasoning สั้นๆ">
            <i data-lucide="brain" class="w-4 h-4 text-purple-400 shrink-0"></i>
            <span class="truncate">อธิบาย LLM Reasoning</span>
          </button>
          <button class="prompt-chip flex items-center gap-2.5 p-3 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-blue-500/50 hover:bg-zinc-800/60 text-left text-xs text-zinc-300 transition-all" data-prompt="ช่วยแนะนำสถาปัตยกรรม Microservices">
            <i data-lucide="cpu" class="w-4 h-4 text-emerald-400 shrink-0"></i>
            <span class="truncate">แนะนำ Microservices</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Input Box -->
    <div class="border-t border-zinc-800 p-4 bg-zinc-900/40 shrink-0">
      <div class="max-w-3xl mx-auto">
        <div class="relative flex items-end rounded-2xl bg-zinc-900 border border-zinc-700/60 shadow-lg focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 transition-all">
          <textarea id="chat-input" rows="1" placeholder="Message AI... (Shift+Enter for newline)" class="w-full resize-none bg-transparent px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none max-h-40"></textarea>
          <div class="p-2 shrink-0 flex items-center gap-1.5">
            <button id="btn-send" class="h-8 w-8 rounded-xl bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              <i data-lucide="send" class="w-3.5 h-3.5"></i>
            </button>
            <button id="btn-stop" class="hidden h-8 w-8 rounded-xl bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-500/30 flex items-center justify-center transition-all">
              <i data-lucide="square" class="w-3 h-3 fill-current"></i>
            </button>
          </div>
        </div>
        <div class="flex items-center justify-between mt-1.5 px-1 text-[11px] text-zinc-500">
          <span>Bridge: <span class="text-zinc-400 font-mono" id="footer-host">http://157.85.96.7:8787</span></span>
          <span>API: <span class="text-blue-400 font-mono">/v1/chat/completions & /v1/messages</span></span>
        </div>
      </div>
    </div>
  </main>

  <!-- SETTINGS MODAL -->
  <div id="modal-settings" class="hidden fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center z-50 p-4">
    <div class="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-5 shadow-2xl space-y-4">
      <div class="flex items-center justify-between border-b border-zinc-800 pb-3">
        <h3 class="text-sm font-semibold text-white flex items-center gap-2">
          <i data-lucide="settings-2" class="w-4 h-4 text-blue-400"></i>
          Bridge Server Settings
        </h3>
        <button id="btn-close-settings" class="text-zinc-400 hover:text-zinc-200">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>

      <div class="space-y-3 text-xs">
        <div>
          <label class="block text-zinc-300 font-medium mb-1">Update Session Cookie</label>
          <textarea id="cookie-input" rows="3" placeholder="Paste __Secure-ai_passport_auth cookie..." class="w-full bg-zinc-950 border border-zinc-700/60 rounded-xl p-2.5 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500"></textarea>
          <p class="text-[11px] text-zinc-500 mt-1">Updates the live session token immediately without restarting.</p>
        </div>

        <div id="cookie-alert" class="hidden p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
          Cookie updated successfully!
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
        <button id="btn-cancel-settings" class="px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 rounded-lg">Cancel</button>
        <button id="btn-save-cookie" class="px-3.5 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg shadow">Apply Cookie</button>
      </div>
    </div>
  </div>

  <script>
    lucide.createIcons();

    const BASE_URL = window.location.origin;
    document.getElementById('server-host').innerText = BASE_URL;
    document.getElementById('footer-host').innerText = BASE_URL;

    let activeAbortController = null;
    let allConversations = [];

    // Fetch models & status
    async function loadStatus() {
      const start = performance.now();
      try {
        const res = await fetch(\`\${BASE_URL}/status\`);
        const ping = Math.round(performance.now() - start);
        document.getElementById('server-ping').innerText = \`\${ping}ms\`;
        if (res.ok) {
          const data = await res.json();
          document.getElementById('status-dot').className = 'h-2 w-2 rounded-full bg-emerald-500';
          document.getElementById('status-text').innerText = data.directMode ? 'Direct Headless' : 'Extension Linked';
        }
      } catch {
        document.getElementById('status-dot').className = 'h-2 w-2 rounded-full bg-red-500';
        document.getElementById('status-text').innerText = 'Disconnected';
      }
    }

    async function loadModels() {
      try {
        const res = await fetch(\`\${BASE_URL}/v1/models\`);
        if (!res.ok) return;
        const data = await res.json();
        const select = document.getElementById('model-select');
        select.innerHTML = '';
        (data.data || []).forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.innerText = \`\${m.name || m.id} \${m.free_credit ? '[Free]' : ''}\`;
          select.appendChild(opt);
        });
      } catch {}
    }

    async function loadConversations() {
      try {
        const res = await fetch(\`\${BASE_URL}/conversations\`);
        if (!res.ok) return;
        const data = await res.json();
        allConversations = data.conversations || [];
        renderConversations(allConversations);
      } catch {}
    }

    function renderConversations(list) {
      const container = document.getElementById('conv-items');
      if (!list.length) {
        container.innerHTML = '<div class="px-2 py-3 text-zinc-500 text-center">No conversations</div>';
        return;
      }
      container.innerHTML = list.map(c => \`
        <button class="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-zinc-800/80 hover:text-zinc-200 flex items-center gap-2 truncate transition-colors" onclick="selectConversation('\${c.id}')">
          <i data-lucide="message-square" class="w-3.5 h-3.5 text-zinc-500 shrink-0"></i>
          <span class="truncate">\${c.title || c.id}</span>
        </button>
      \`).join('');
      lucide.createIcons();
    }

    window.selectConversation = async (id) => {
      await fetch(\`\${BASE_URL}/config\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation: id })
      });
      document.getElementById('messages-container').innerHTML = '';
      loadConversations();
    };

    document.getElementById('btn-new-chat').onclick = async () => {
      const model = document.getElementById('model-select').value;
      const res = await fetch(\`\${BASE_URL}/conversations/new\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, message: 'New conversation' })
      });
      document.getElementById('messages-container').innerHTML = '';
      loadConversations();
    };

    document.getElementById('search-conv').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      renderConversations(allConversations.filter(c => (c.title || c.id).toLowerCase().includes(q)));
    };

    // Chat sending
    async function sendMessage(text) {
      if (!text.trim() || activeAbortController) return;

      const empty = document.getElementById('empty-state');
      if (empty) empty.remove();

      const container = document.getElementById('messages-container');
      const userBubble = document.createElement('div');
      userBubble.className = 'flex flex-col items-end gap-1 max-w-3xl mx-auto';
      userBubble.innerHTML = \`
        <div class="text-[11px] text-zinc-500">You</div>
        <div class="bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-2xl px-4 py-2.5 text-sm max-w-[85%] shadow-sm leading-relaxed">\${escapeHtml(text)}</div>
      \`;
      container.appendChild(userBubble);

      const aiBubble = document.createElement('div');
      aiBubble.className = 'flex flex-col items-start gap-1 max-w-3xl mx-auto w-full';
      const aiId = 'msg-' + Date.now();
      aiBubble.innerHTML = \`
        <div class="text-[11px] text-zinc-500">\${document.getElementById('model-select').value}</div>
        <div id="\${aiId}" class="bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-2xl p-4 text-sm w-full shadow-sm leading-relaxed prose prose-invert max-w-none">
          <span class="inline-flex items-center gap-1.5 text-zinc-400 animate-pulse">
            <span class="h-2 w-2 rounded-full bg-blue-400"></span> Generating response...
          </span>
        </div>
      \`;
      container.appendChild(aiBubble);
      container.scrollTop = container.scrollHeight;

      document.getElementById('chat-input').value = '';
      document.getElementById('btn-send').classList.add('hidden');
      document.getElementById('btn-stop').classList.remove('hidden');

      const controller = new AbortController();
      activeAbortController = controller;

      const model = document.getElementById('model-select').value;
      let fullContent = '';
      let reasoningContent = '';

      try {
        const response = await fetch(\`\${BASE_URL}/v1/chat/completions\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: true,
            messages: [{ role: 'user', content: text }]
          }),
          signal: controller.signal
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let cut;
          while ((cut = buffer.indexOf('\\n\\n')) !== -1) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const lines = frame.split('\\n').filter(l => l.startsWith('data:'));
            const dataStr = lines.map(l => l.slice(5).trim()).join('');
            if (!dataStr || dataStr === '[DONE]') continue;

            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed.choices?.[0]?.delta;
              if (delta) {
                if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
                if (delta.content) fullContent += delta.content;

                let html = '';
                if (reasoningContent) {
                  html += \`<details class="mb-3 bg-zinc-950/70 p-2.5 rounded-xl border border-zinc-800 text-xs text-zinc-400 font-mono"><summary class="cursor-pointer font-medium text-purple-400">Thinking Process</summary><div class="mt-2 whitespace-pre-wrap">\${escapeHtml(reasoningContent)}</div></details>\`;
                }
                html += marked.parse(fullContent || '...');
                document.getElementById(aiId).innerHTML = html;
                document.querySelectorAll('pre code').forEach((el) => hljs.highlightElement(el));
                container.scrollTop = container.scrollHeight;
              }
            } catch {}
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          document.getElementById(aiId).innerHTML = \`<span class="text-red-400">❌ Error: \${err.message}</span>\`;
        }
      } finally {
        activeAbortController = null;
        document.getElementById('btn-send').classList.remove('hidden');
        document.getElementById('btn-stop').classList.add('hidden');
        loadConversations();
      }
    }

    document.getElementById('btn-send').onclick = () => sendMessage(document.getElementById('chat-input').value);
    document.getElementById('btn-stop').onclick = () => { if (activeAbortController) activeAbortController.abort(); };
    document.getElementById('chat-input').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(e.target.value);
      }
    };

    document.querySelectorAll('.prompt-chip').forEach(btn => {
      btn.onclick = () => sendMessage(btn.getAttribute('data-prompt'));
    });

    // Settings
    document.getElementById('btn-settings').onclick = () => document.getElementById('modal-settings').classList.remove('hidden');
    document.getElementById('btn-close-settings').onclick = () => document.getElementById('modal-settings').classList.add('hidden');
    document.getElementById('btn-cancel-settings').onclick = () => document.getElementById('modal-settings').classList.add('hidden');

    document.getElementById('btn-save-cookie').onclick = async () => {
      const cookie = document.getElementById('cookie-input').value.trim();
      if (!cookie) return;
      const res = await fetch(\`\${BASE_URL}/cookie\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie })
      });
      if (res.ok) {
        document.getElementById('cookie-alert').classList.remove('hidden');
        setTimeout(() => {
          document.getElementById('cookie-alert').classList.add('hidden');
          document.getElementById('modal-settings').classList.add('hidden');
        }, 1500);
        loadStatus();
        loadModels();
      }
    };

    async function loadUserProfile() {
      try {
        const res = await fetch(\`\${BASE_URL}/profile\`);
        if (!res.ok) return;
        const data = await res.json();
        const p = data.profile;
        if (p) {
          document.getElementById('user-name').innerText = p.name || 'WK 18K';
          document.getElementById('user-email').innerText = p.email || 'Active Session';
          document.getElementById('user-plan').innerText = p.plan || 'Free Plan';
          document.getElementById('user-avatar').innerText = (p.name || 'WK').slice(0, 2).toUpperCase();

          if (p.credits) {
            const avail = typeof p.credits === 'object' ? p.credits.available : p.credits;
            document.getElementById('user-credits').innerText = typeof avail === 'number' ? avail.toLocaleString() : avail;

            if (typeof p.credits === 'object') {
              const used = p.credits.used ?? '--';
              const limit = p.credits.limit ?? '--';
              document.getElementById('credits-detail').innerText = \`Used: \${used} / Limit: \${limit}\`;
              const bar = document.getElementById('credits-bar');
              if (bar) bar.style.width = \`\${p.credits.availablePercent ?? 100}%\`;

              if (p.credits.periodEndsAt) {
                try {
                  const d = new Date(p.credits.periodEndsAt);
                  document.getElementById('credits-reset').innerText = \`Reset \${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\`;
                } catch {}
              }
            }
          }

          if (p.videoQuota) {
            document.getElementById('quota-video').innerText = \`\${p.videoQuota.remaining}/\${p.videoQuota.limit}\`;
          }
          if (p.deepResearchQuota) {
            document.getElementById('quota-research').innerText = \`\${p.deepResearchQuota.remaining}/\${p.deepResearchQuota.limit}\`;
          }
          if (p.audioQuota) {
            document.getElementById('quota-audio').innerText = \`\${p.audioQuota.remaining}/\${p.audioQuota.limit}\`;
          }
        }
      } catch {}
    }

    document.getElementById('btn-refresh').onclick = () => {
      loadStatus();
      loadModels();
      loadConversations();
      loadUserProfile();
    };

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Init
    loadStatus();
    loadModels();
    loadConversations();
    loadUserProfile();
    setInterval(loadStatus, 5000);
    setInterval(loadUserProfile, 30000);
  </script>
</body>
</html>`;
}


server.listen(PORT, HOST, () => {
  log(`aipass bridge on http://${HOST}:${PORT}`);
  log(`  default model : ${defaultModel}`);
  log(`  conversation  : ${PINNED_CONVERSATION || 'most recent on the account'}`);
  if (getCookie()) {
    log('  mode          : direct (AIPASS_COOKIE found, headless ready)');
    setTimeout(() => listModels({ force: true }).catch(() => {}), 500);
  } else {
    log('  waiting for Chrome extension or AIPASS_COOKIE…');
  }
});

// Periodic Keep-Alive Heartbeat (every 30 mins) to auto-refresh sliding session
setInterval(async () => {
  if (!getCookie()) return;
  try {
    const res = await fetch(`${AIPASS_ORIGIN}/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models`, {
      headers: {
        cookie: getCookie(),
        accept: '*/*',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        referer: `${AIPASS_ORIGIN}/chat`,
      },
    });
    updateCookiesFromResponse(res);
  } catch (err) {
    log('keep-alive ping error:', err.message);
  }
}, 30 * 60 * 1000);


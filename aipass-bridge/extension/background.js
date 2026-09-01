// Service worker: holds the long-lived connection to the local bridge and
// routes each job into a de.aipass.net tab.
//
// The connection lives here rather than in the content script because an
// https:// page talking to http://127.0.0.1 runs into mixed-content and
// Private Network Access checks; an extension request with host_permissions
// does not.
const DEFAULT_BRIDGE = 'http://127.0.0.1:8787';
const RECONNECT_MS = 3000;
const CYCLE_MS = 4 * 60 * 1000; // reconnect before Chrome's long-request ceiling

let controller = null;
let connected = false;
let lastError = '';
const jobTabs = new Map();

const bridgeUrl = async () =>
  (await chrome.storage.local.get('bridgeUrl')).bridgeUrl || DEFAULT_BRIDGE;

async function post(path, body) {
  try {
    await fetch(`${await bridgeUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    lastError = String(err?.message ?? err);
  }
}

async function findChatTab() {
  const tabs = await chrome.tabs.query({ url: 'https://de.aipass.net/*' });
  if (!tabs.length) return null;
  const live = tabs.filter((t) => !t.discarded && t.status !== 'unloaded');
  const pool = live.length ? live : tabs;
  // Prefer a tab already sitting on a chat route.
  return pool.find((t) => t.url?.includes('/chat')) ?? pool[0];
}

function waitForComplete(tabId, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error('tab did not finish loading')); }, timeoutMs);
    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// A tab opened before the extension was loaded or reloaded has no content
// script in it, and Chrome's memory saver can discard one entirely. Rather
// than telling the user to reload, put the scripts back.
async function ensureContentScript(tab) {
  const ping = () => chrome.tabs.sendMessage(tab.id, { type: 'ping' });
  try { await ping(); return; } catch { /* not there yet */ }

  if (tab.discarded || tab.status === 'unloaded') {
    await chrome.tabs.reload(tab.id);
    await waitForComplete(tab.id);
    try { await ping(); return; } catch { /* fall through to injection */ }
  }

  // page.js first: content.js relays to it.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['page.js'] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ['content.js'] });
  await ping();
}

async function handleJob(job) {
  const tab = await findChatTab();
  if (!tab) {
    await post('/ext/error', { jobId: job.jobId, message: 'no de.aipass.net tab is open' });
    return;
  }
  jobTabs.set(job.jobId, tab.id);
  try {
    await ensureContentScript(tab);
    await chrome.tabs.sendMessage(tab.id, { type: 'run', job });
  } catch (err) {
    jobTabs.delete(job.jobId);
    await post('/ext/error', {
      jobId: job.jobId,
      message: `could not reach the de.aipass.net tab (${tab.url ?? tab.id}): ${err?.message ?? err}`,
    });
  }
}

function handleEvent(name, data) {
  if (name === 'job') handleJob(data);
  else if (name === 'abort') {
    const tabId = jobTabs.get(data.jobId);
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'abort', jobId: data.jobId }).catch(() => {});
    jobTabs.delete(data.jobId);
  }
}

async function connect() {
  if (controller) return;
  controller = new AbortController();
  const signal = controller.signal;
  const cycle = setTimeout(() => controller?.abort(), CYCLE_MS);

  try {
    const res = await fetch(`${await bridgeUrl()}/ext/events`, {
      headers: { accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`bridge responded ${res.status}`);

    connected = true;
    lastError = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      let cut;
      while ((cut = pending.search(/\r?\n\r?\n/)) !== -1) {
        const frame = pending.slice(0, cut);
        pending = pending.slice(cut + pending.slice(cut).match(/^\r?\n\r?\n/)[0].length);

        let name = 'message';
        const dataLines = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue; // comment / keepalive
        try { handleEvent(name, JSON.parse(dataLines.join('\n'))); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') lastError = String(err?.message ?? err);
  } finally {
    clearTimeout(cycle);
    connected = false;
    controller = null;
    setTimeout(connect, RECONNECT_MS);
  }
}

// A content script holds this port open so Chrome does not evict the worker.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive') return;
  connect(); // a de.aipass.net tab just appeared (or the worker just woke)
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'from-page') {
    const p = msg.payload;
    if (p.kind === 'chunk') post('/ext/chunk', { jobId: p.jobId, parts: p.parts });
    else if (p.kind === 'done') { jobTabs.delete(p.jobId); post('/ext/done', { jobId: p.jobId, finishReason: p.finishReason }); }
    else if (p.kind === 'error') { jobTabs.delete(p.jobId); post('/ext/error', { jobId: p.jobId, message: p.message }); }
    else if (p.kind === 'loader') { jobTabs.delete(p.jobId); post('/ext/loader', { jobId: p.jobId, raw: p.raw, message: p.message }); }
    return;
  }
  if (msg?.type === 'status') {
    (async () => {
      const tab = await findChatTab();
      sendResponse({
        connected,
        lastError,
        bridgeUrl: await bridgeUrl(),
        tab: tab ? { id: tab.id, url: tab.url } : null,
        activeJobs: jobTabs.size,
      });
    })();
    return true;
  }
  if (msg?.type === 'reconnect') { controller?.abort(); connect(); sendResponse({ ok: true }); return true; }
  if (msg?.type === 'run_action') {
    executePageAction(msg.action, msg.tabId, msg.selectionText || '', msg.lang || '');
    sendResponse({ ok: true });
    return true;
  }
});

// Register Context Menus
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'aipass_summarize',
      title: '✨ AIPass: Summarize this page',
      contexts: ['page', 'selection'],
    });
    chrome.contextMenus.create({
      id: 'aipass_extract_code',
      title: '💻 AIPass: Extract Code & Data',
      contexts: ['page', 'selection'],
    });
    chrome.contextMenus.create({
      id: 'aipass_convert_api',
      title: '⚡ AIPass: Convert page to REST API / JSON',
      contexts: ['page', 'selection'],
    });
    chrome.contextMenus.create({
      id: 'aipass_explain',
      title: '🔍 AIPass: Explain selection',
      contexts: ['selection'],
    });
  });
}

async function executePageAction(action, tabId, selectionText = '', explicitLang = '') {
  const storedLang = (await chrome.storage.local.get('summaryLang')).summaryLang || 'th';
  const lang = explicitLang || storedLang || 'th';

  const langNames = {
    th: 'ภาษาไทย (Thai)',
    en: 'English',
    ja: '日本語 (Japanese)',
    zh: '简体中文 (Simplified Chinese)',
  };
  const targetLangName = langNames[lang] || 'ภาษาไทย (Thai)';
  const langTag = lang.toUpperCase();

  let actionTitle = 'Analyzing';
  let promptPrefix = 'Please analyze this page:';

  if (action === 'summarize' || action === 'aipass_summarize') {
    actionTitle = `Summarize · ${langTag}`;
    promptPrefix = `You are an expert concise analyst. Follow the strict Stop-Slop (Anti-AI Slop) guidelines:
1. Target Output Language: ${targetLangName}. Write the entire summary in fluent, natural ${targetLangName}.
2. NO throat-clearing openers (Do NOT start with "สรุปข้อมูลจากเนื้อหาที่ให้มาครับ:", "Here is the summary:", or "In summary:"). Start immediately with the first key fact or point.
3. NO conversational padding, filler phrases, or helpful sign-off questions at the end (Do NOT say "คุณต้องการให้ผมช่วยอะไรเพิ่มเติมไหมครับ?").
4. Be direct, specific, and fact-focused. Use active voice and concrete specifics (exact names, numbers, salaries, dates, locations, requirements).
5. Organize into crisp Markdown headers and bullet points.

Provide a high-impact, direct summary of the following content in ${targetLangName}:`;
  } else if (action === 'code' || action === 'extract_code' || action === 'aipass_extract_code') {
    actionTitle = 'Extract Code';
    promptPrefix = `Extract all programming code blocks, API endpoints, data models, or structured tables from this content. Return ONLY the extracted code and clean Markdown tables without filler prose:`;
  } else if (action === 'convert_api' || action === 'aipass_convert_api') {
    actionTitle = 'Convert to API';
    promptPrefix = `Convert the data and structure of this page into a clean JSON REST API schema and sample response. Output ONLY the JSON/Schema without filler prose:`;
  } else if (action === 'explain' || action === 'aipass_explain') {
    actionTitle = `Explain · ${langTag}`;
    promptPrefix = `Explain this selected text directly and clearly with practical context in ${targetLangName}, following Stop-Slop rules (no throat-clearing, direct facts only):`;
  }

  // 1. Inject overlay into the active tab
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js'],
    });

    // 2. Extract text if not provided
    let targetText = selectionText || '';
    if (!targetText) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.body.innerText.slice(0, 15000),
      });
      targetText = result || '';
    }

    if (!targetText.trim()) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (tag) => window.__aipassSetOverlay?.(tag, 'No readable text content found on this page.', true),
        args: [actionTitle],
      });
      return;
    }

    // 3. Set initial loading state in overlay
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (tag) => window.__aipassSetOverlay?.(tag, 'Connecting to AIPass Bridge and generating response...'),
      args: [actionTitle],
    });

    // 4. Stream from Bridge
    const bUrl = await bridgeUrl();
    const finalPrompt = `${promptPrefix}

"""
${targetText}
"""

[CRITICAL REQUIREMENT - OUTPUT LANGUAGE]:
Write the entire output exclusively in ${targetLangName}. All headings, bullet points, explanations, and descriptions MUST be in ${targetLangName}. Do NOT output in English or another language (only keep code snippets, URLs, and proper nouns in their original form).`;

    const res = await fetch(`${bUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.1-flash-lite',
        messages: [{ role: 'user', content: finalPrompt }],
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (tag, msg) => window.__aipassSetOverlay?.(tag, `Error (${res.status}): ${msg}`, true),
        args: [actionTitle, errText || res.statusText],
      });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let pending = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      const lines = pending.split('\n');
      pending = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          if (delta) {
            accumulated += delta;
            chrome.scripting.executeScript({
              target: { tabId },
              func: (tag, text) => window.__aipassSetOverlay?.(tag, text, false),
              args: [actionTitle, accumulated],
            }).catch(() => {});
          }
        } catch {}
      }
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (tag, text) => window.__aipassSetOverlay?.(tag, text, true),
      args: [actionTitle, accumulated || 'No response returned.'],
    });
  } catch (err) {
    chrome.scripting.executeScript({
      target: { tabId },
      func: (tag, err) => window.__aipassSetOverlay?.(tag, `Error: ${err}`, true),
      args: [actionTitle, String(err?.message ?? err)],
    }).catch(() => {});
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id) {
    executePageAction(info.menuItemId, tab.id, info.selectionText || '');
  }
});

// The worker can be evicted at any time; the alarm brings it back and the
// connect() guard makes a duplicate call harmless.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
  connect();
});
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
  connect();
});
connect();


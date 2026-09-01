const $ = (id) => document.getElementById(id);
let bridge = 'http://157.85.96.7:8787';
let lastModelSignature = '';

async function bridgeStatus(refresh = false) {
  try {
    const res = await fetch(`${bridge}/status`, { cache: 'no-store' });
    if (!res.ok) return null;
    const s = await res.json();
    if (refresh) await fetch(`${bridge}/v1/models?refresh=1`, { cache: 'no-store' });
    return s;
  } catch {
    return null;
  }
}

async function loadQuota() {
  try {
    const res = await fetch(`${bridge}/profile`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const p = data.profile;
    if (p) {
      if (p.plan) $('user-plan').textContent = p.plan;
      if (p.credits) {
        const avail = typeof p.credits === 'object' ? p.credits.available : p.credits;
        $('quota-val').textContent = typeof avail === 'number' ? avail.toLocaleString() : avail;
        if (typeof p.credits === 'object') {
          $('quota-detail').textContent = `Used: ${p.credits.used ?? '--'} / Limit: ${p.credits.limit ?? '--'}`;
          const bar = $('quota-bar');
          if (bar) bar.style.width = `${p.credits.availablePercent ?? 100}%`;
        }
      }
    }
  } catch {}
}

function renderModels(models, selected) {
  const signature = `${models.map((m) => `${m.id}${m.free}`).join('|')}::${selected}`;
  if (signature === lastModelSignature) return;
  lastModelSignature = signature;

  const sel = $('model');
  sel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    const tags = [m.free ? 'Free' : null, m.thinking ? 'Thinking' : null].filter(Boolean);
    opt.textContent = `${m.name || m.id}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
    opt.selected = m.id === selected;
    sel.append(opt);
  }
  if (!models.some((m) => m.id === selected)) {
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = selected;
    opt.selected = true;
    sel.prepend(opt);
  }
  $('count').textContent = models.length ? `(${models.length})` : '';
}

async function refresh(forceModels = false) {
  const sw = await chrome.runtime.sendMessage({ type: 'status' }).catch(() => ({}));
  if (sw && sw.bridgeUrl) bridge = sw.bridgeUrl;

  const isConnected = Boolean(sw?.connected);
  $('conn-dot').className = isConnected ? 'dot' : 'dot down';
  $('conn-text').textContent = isConnected ? 'Connected' : 'Offline';

  if (document.activeElement !== $('url')) $('url').value = bridge;

  const status = await bridgeStatus(forceModels);
  if (status) {
    renderModels(status.models ?? [], status.defaultModel);
    loadQuota();
  }

  const errEl = $('err');
  const errorMsg = sw?.lastError || (status ? '' : 'Bridge not reachable. Please check your VPS or server.mjs.');
  if (errorMsg) {
    errEl.textContent = errorMsg;
    errEl.style.display = 'block';
  } else {
    errEl.style.display = 'none';
  }
}

$('model').addEventListener('change', async () => {
  await fetch(`${bridge}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultModel: $('model').value }),
  }).catch(() => {});
});

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ bridgeUrl: $('url').value.trim().replace(/\/+$/, '') });
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(() => refresh(true), 400);
});

$('refresh').addEventListener('click', () => refresh(true));

$('btn-open-dash').addEventListener('click', () => {
  chrome.tabs.create({ url: `${bridge}/dashboard` });
});

// Quick Action: Summarize Current Tab
$('btn-qa-summarize').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'trigger_action', action: 'summarize' }).catch(() => {});
  window.close();
});

// Quick Action: Extract Code from Tab
$('btn-qa-code').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'trigger_action', action: 'code' }).catch(() => {});
  window.close();
});

refresh(true);
setInterval(() => refresh(false), 2000);
if (window.lucide) window.lucide.createIcons();

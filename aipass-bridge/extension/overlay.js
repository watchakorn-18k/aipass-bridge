// In-Page AI Assistant Overlay for AIPass Chrome Extension
(() => {
  let overlay = document.getElementById('aipass-floating-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'aipass-floating-overlay';
    overlay.innerHTML = `
      <style>
        #aipass-floating-overlay {
          position: fixed;
          top: 24px;
          right: 24px;
          width: 440px;
          max-width: calc(100vw - 48px);
          max-height: 85vh;
          background: rgba(15, 17, 23, 0.94);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 16px;
          box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
          color: #f3f4f6;
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          z-index: 2147483647;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s;
        }
        #aipass-header {
          padding: 12px 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.03);
          cursor: move;
          user-select: none;
        }
        #aipass-body {
          padding: 16px;
          overflow-y: auto;
          font-size: 13px;
          line-height: 1.6;
          flex: 1;
          color: #e5e7eb;
          white-space: pre-wrap;
          word-break: break-word;
        }
        #aipass-footer {
          padding: 10px 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 11px;
          color: #9ca3af;
          background: rgba(0, 0, 0, 0.2);
        }
        .aipass-btn {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #f3f4f6;
          border-radius: 6px;
          padding: 4px 10px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
        }
        .aipass-btn:hover {
          background: rgba(255, 255, 255, 0.16);
        }
        .aipass-badge {
          background: rgba(59, 130, 246, 0.15);
          color: #60a5fa;
          border: 1px solid rgba(59, 130, 246, 0.3);
          border-radius: 12px;
          padding: 2px 8px;
          font-size: 10px;
          font-weight: 600;
        }
      </style>
      <div id="aipass-header">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;">
            ✨ AIPass Copilot
          </span>
          <span id="aipass-action-tag" class="aipass-badge">Analyzing</span>
        </div>
        <button id="aipass-close-btn" style="background:transparent;border:none;color:#9ca3af;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;">&times;</button>
      </div>
      <div id="aipass-body">Connecting to AIPass Bridge...</div>
      <div id="aipass-footer">
        <span id="aipass-status-lbl">⚡ Powered by AIPass Bridge</span>
        <button id="aipass-copy-btn" class="aipass-btn">Copy Text</button>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('aipass-close-btn').onclick = () => overlay.remove();
    document.getElementById('aipass-copy-btn').onclick = () => {
      const text = document.getElementById('aipass-body').innerText;
      navigator.clipboard.writeText(text);
      document.getElementById('aipass-copy-btn').innerText = 'Copied!';
      setTimeout(() => { document.getElementById('aipass-copy-btn').innerText = 'Copy Text'; }, 1500);
    };

    // Make Draggable
    const header = document.getElementById('aipass-header');
    let isDragging = false;
    let startX, startY, initialX, initialY;

    header.onmousedown = (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = overlay.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;
      document.onmousemove = (ev) => {
        if (!isDragging) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        overlay.style.right = 'auto';
        overlay.style.left = `${Math.max(10, initialX + dx)}px`;
        overlay.style.top = `${Math.max(10, initialY + dy)}px`;
      };
      document.onmouseup = () => { isDragging = false; };
    };
  }

  window.__aipassSetOverlay = (tag, content, isDone = false) => {
    if (tag) {
      const tagEl = document.getElementById('aipass-action-tag');
      if (tagEl) tagEl.innerText = tag;
    }
    const body = document.getElementById('aipass-body');
    if (body) body.innerText = content;
    if (isDone) {
      const lbl = document.getElementById('aipass-status-lbl');
      if (lbl) lbl.innerText = '✔ Complete';
    }
  };
})();

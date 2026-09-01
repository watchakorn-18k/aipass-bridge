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
          width: 480px;
          max-width: calc(100vw - 48px);
          max-height: 85vh;
          background: rgba(15, 17, 23, 0.96);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 16px;
          box-shadow: 0 24px 48px -12px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.06);
          color: #f3f4f6;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
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
          background: rgba(255, 255, 255, 0.02);
          cursor: move;
          user-select: none;
        }
        #aipass-body {
          padding: 18px;
          overflow-y: auto;
          font-size: 13.5px;
          line-height: 1.65;
          flex: 1;
          color: #e5e7eb;
          word-break: break-word;
        }
        #aipass-body .aipass-h1 {
          font-size: 17px;
          font-weight: 700;
          color: #ffffff;
          margin: 12px 0 8px;
        }
        #aipass-body .aipass-h2 {
          font-size: 15px;
          font-weight: 700;
          color: #60a5fa;
          margin: 14px 0 6px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        #aipass-body .aipass-h3 {
          font-size: 14px;
          font-weight: 600;
          color: #93c5fd;
          margin: 12px 0 6px;
        }
        #aipass-body strong {
          color: #f9fafb;
          font-weight: 600;
        }
        #aipass-body .aipass-ul {
          margin: 6px 0 10px 18px;
          padding: 0;
          list-style-type: disc;
        }
        #aipass-body .aipass-li {
          margin-bottom: 4px;
          color: #d1d5db;
        }
        #aipass-body .aipass-hr {
          border: 0;
          height: 1px;
          background: rgba(255, 255, 255, 0.1);
          margin: 14px 0;
        }
        #aipass-body .aipass-blockquote {
          border-left: 3px solid #3b82f6;
          padding-left: 10px;
          margin: 8px 0;
          color: #9ca3af;
          font-style: italic;
        }
        #aipass-body .aipass-p-space {
          height: 10px;
        }
        #aipass-body .aipass-inline-code {
          background: rgba(255, 255, 255, 0.1);
          color: #38bdf8;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        #aipass-body .aipass-code-wrap {
          background: #0d0e12;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          margin: 12px 0;
          overflow: hidden;
        }
        #aipass-body .aipass-code-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 6px 12px;
          background: rgba(255, 255, 255, 0.04);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          font-size: 11px;
          font-family: monospace;
          color: #9ca3af;
        }
        #aipass-body .aipass-code-copy {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #e5e7eb;
          border-radius: 4px;
          padding: 2px 8px;
          font-size: 10px;
          cursor: pointer;
          transition: background 0.15s;
        }
        #aipass-body .aipass-code-copy:hover {
          background: rgba(255, 255, 255, 0.18);
        }
        #aipass-body pre {
          margin: 0;
          padding: 12px;
          overflow-x: auto;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12px;
          line-height: 1.5;
          color: #7dd3fc;
        }
        #aipass-footer {
          padding: 10px 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 11px;
          color: #9ca3af;
          background: rgba(0, 0, 0, 0.25);
        }
        .aipass-btn {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #f3f4f6;
          border-radius: 8px;
          padding: 5px 12px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 5px;
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
          padding: 2px 10px;
          font-size: 10px;
          font-weight: 600;
        }
        .ri-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          vertical-align: middle;
        }
      </style>
      <div id="aipass-header">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;color:#ffffff;">
            <svg class="ri-icon" viewBox="0 0 24 24" width="16" height="16" fill="#60a5fa"><path d="M12 2l2.4 7.2L21.6 12l-7.2 2.4L12 21.6l-2.4-7.2L2.4 12l7.2-2.4L12 2zm0 4.8l-1.1 3.3-3.3 1.1 3.3 1.1 1.1 3.3 1.1-3.3 3.3-1.1-3.3-1.1L12 6.8z"/></svg>
            AIPass Copilot
          </span>
          <span id="aipass-action-tag" class="aipass-badge">Analyzing</span>
        </div>
        <button id="aipass-close-btn" style="background:transparent;border:none;color:#9ca3af;cursor:pointer;padding:4px;display:flex;align-items:center;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div id="aipass-body">Connecting to AIPass Bridge...</div>
      <div id="aipass-footer">
        <span id="aipass-status-lbl" style="display:flex;align-items:center;gap:5px;">
          <svg class="ri-icon" viewBox="0 0 24 24" width="13" height="13" fill="#f59e0b"><path d="M13 10h7l-9 13v-9H4l9-13v9z"/></svg>
          Powered by AIPass Bridge
        </span>
        <button id="aipass-copy-btn" class="aipass-btn">
          <svg class="ri-icon" viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M7 6V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3v3c0 .552-.45 1-1.007 1H4.007A1.001 1.001 0 0 1 3 21l.003-14c0-.552.45-1 1.007-1H7zM5.002 8L5 20h10V8H5.002zM9 6h8v10h2V4H9v2z"/></svg>
          <span id="aipass-copy-text">Copy Text</span>
        </button>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('aipass-close-btn').onclick = () => overlay.remove();
    document.getElementById('aipass-copy-btn').onclick = () => {
      const body = document.getElementById('aipass-body');
      const text = body ? body.innerText : '';
      navigator.clipboard.writeText(text);
      document.getElementById('aipass-copy-text').innerText = 'Copied!';
      setTimeout(() => { document.getElementById('aipass-copy-text').innerText = 'Copy Text'; }, 1500);
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

  function renderMarkdown(md) {
    if (!md) return '';
    let html = md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Code blocks: ```lang ... ```
    html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      return `<div class="aipass-code-wrap">
        <div class="aipass-code-head">
          <span>${lang || 'code'}</span>
          <button class="aipass-code-copy" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.innerText);this.innerText='Copied!';setTimeout(()=>this.innerText='Copy',1200)">Copy</button>
        </div>
        <pre><code>${code.trim()}</code></pre>
      </div>`;
    });

    // Inline code: `code`
    html = html.replace(/`([^`]+)`/g, '<code class="aipass-inline-code">$1</code>');

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3 class="aipass-h3">$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2 class="aipass-h2">$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1 class="aipass-h1">$1</h1>');

    // Horizontal Rule
    html = html.replace(/^---$/gim, '<hr class="aipass-hr" />');

    // Bold & Italic
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Blockquotes
    html = html.replace(/^&gt; (.*$)/gim, '<blockquote class="aipass-blockquote">$1</blockquote>');

    // Lists: lines starting with * or -
    html = html.replace(/^[*-] (.*$)/gim, '<li class="aipass-li">$1</li>');
    html = html.replace(/(<li class="aipass-li">.*<\/li>\n?)+/g, '<ul class="aipass-ul">$&</ul>');

    // Paragraph breaks
    html = html.replace(/\n\n+/g, '<div class="aipass-p-space"></div>');

    return html;
  }

  window.__aipassSetOverlay = (tag, content, isDone = false) => {
    if (tag) {
      const tagEl = document.getElementById('aipass-action-tag');
      if (tagEl) tagEl.innerText = tag;
    }
    const body = document.getElementById('aipass-body');
    if (body) {
      body.innerHTML = renderMarkdown(content);
    }
    if (isDone) {
      const lbl = document.getElementById('aipass-status-lbl');
      if (lbl) {
        lbl.innerHTML = `
          <svg class="ri-icon" viewBox="0 0 24 24" width="13" height="13" fill="#10b981"><path d="M9 16.2l-3.5-3.5a.984.984 0 0 0-1.4 0 .984.984 0 0 0 0 1.4l4.2 4.2c.39.39 1.01.39 1.4 0l11-11a.984.984 0 0 0 0-1.4.984.984 0 0 0-1.4 0L9 16.2z"/></svg>
          Complete
        `;
      }
    }
  };
})();

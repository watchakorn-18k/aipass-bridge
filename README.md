# 🚀 Web AI Bridge

An open-source developer interoperability proxy and local API gateway for authorized web sessions, providing standard OpenAI-compatible endpoints, real-time SSE streaming, and terminal utilities.

---

## 🌟 Features

- 🔌 **OpenAI-Compatible API (`/v1/chat/completions`, `/v1/models`):** Connect directly to Cursor, VS Code (Cline / Roo Code / Aider), Open WebUI, Chatbox, Python/Node.js OpenAI SDKs.
- 🍪 **Direct Headless Mode (via Cookie):** Run standalone 24/7 on servers **without keeping any browser tab open**.
- 🔄 **Sliding Session Keep-Alive & Auto-Refresh:** Automatic 30-minute keepalive heartbeat and seamless session cookie persistence to prevent expiry.
- 🧩 **Browser Extension Mode:** Zero-credential forwarding mode inside a live browser tab.
- ⚡ **Real-time SSE Streaming & Web Search:** Live token streaming with tool reasoning and source citations.
- 🤖 **Autonomous Coding Agent (`bun run agent`):** In-repo tool for project inspection, diff previews, and safe file modifications.

---

## 🛠️ Architecture

```
[ Terminal / API / Cursor / SDK / Python ] 
                  │ HTTP (OpenAI API Standard)
                  ▼
┌────────────────────────────────────────────────────────┐
│                 AI Bridge Server (:8787)               │
│                                                        │
│  [Mode A: Cookie Direct (Headless)] [Mode B: Extension]│
│  Direct fetch with session cookie   Relays over SSE    │
│  + 30m Keep-Alive Heartbeat         to browser tab     │
└───────────┬────────────────────────────────┬───────────┘
            │                                │
            ▼                                ▼
┌────────────────────────────────────────────────────────┐
│             Target Web Portal / Remote Service         │
└────────────────────────────────────────────────────────┘
```

---

## 🚀 Quickstart

### 1. Install Dependencies

```bash
bun install
# or
npm install
```

---

## 🎯 Operating Modes

### Mode 1: Direct Headless Mode (Recommended — No Browser Needed)

Runs headless on a server or in the background without needing a browser or an open tab.

#### Setup:
1. Open the target web portal in your browser and sign in.
2. Press `F12` (Inspect) → **Network** tab → Refresh the page once.
3. Click any request and copy the **`Cookie`** header value from **Request Headers**.
4. Save the cookie into `.env` or `.cookie`:
   ```bash
   echo 'AIPASS_COOKIE="your_cookie_here"' > .env
   # or
   echo "your_cookie_here" > .cookie
   ```
5. Start the bridge:
   ```bash
   AIPASS_HOST=0.0.0.0 bun dev
   ```
   *(The log will display `mode : direct (AIPASS_COOKIE found, headless ready)` — you can now **close your browser completely**)*

> 💡 **Hot-Updating Cookies without Restart:**  
> Update session cookies dynamically via API:  
> `curl -X POST http://localhost:8787/cookie -H "Content-Type: application/json" -d '{"cookie": "..."}'`

---

### Mode 2: Browser Extension Mode

The bridge hands requests to an extension service worker, and the fetch runs inside the active tab where the browser attaches session credentials automatically.

#### Setup:
1. Start the bridge:
   ```bash
   bun dev
   ```
2. Open Chrome/Chromium and navigate to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the folder:
   ```text
   aipass-bridge/extension
   ```
5. Open the chat web portal in a tab and keep it open. The extension popup will show **connected**.

---

## 💬 CLI Usage

### Interactive Chat & One-Shot Commands
```bash
# Interactive chat loop
bun run chat

# One-shot query
bun run chat -- "Summarize today's tech news"

# Specify a model
bun run chat -- --model gemini-3.1-flash-lite "Hello"

# Connect to a remote bridge server
bun run chat -- --bridge http://157.85.96.7:8787 "Hello"
```

### Models & Conversations
```bash
# List available models
bun run models

# List conversations and active conversation ID
bun run conversations
```

### Autonomous Coding Agent
```bash
# Dry run: Inspects files, produces diff preview, touches nothing on disk
bun run agent -- "Add a health check route in express" --root .

# Apply changes to disk
bun run agent -- "Add a health check route" --root . --apply
```

---

## ⚡ OpenAI-Compatible API

Use standard OpenAI client libraries or `curl`:

### cURL (JSON Standard)
```bash
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-lite",
    "messages": [
      { "role": "user", "content": "Hello!" }
    ]
  }'
```

### cURL (Streaming)
```bash
curl -N -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "stream": true,
    "model": "gemini-3.1-flash-lite",
    "messages": [
      { "role": "user", "content": "Explain quantum computing briefly" }
    ]
  }'
```

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="gemini-3.1-flash-lite",
    messages=[{"role": "user", "content": "Hello from Python!"}]
)

print(response.choices[0].message.content)
```

---

## ⚙️ Configuration

| Variable | Default | Description |
|---|---|---|
| `AIPASS_PORT` | `8787` | Server listen port |
| `AIPASS_HOST` | `127.0.0.1` | Server listen host (`0.0.0.0` for remote access) |
| `AIPASS_COOKIE` | *(unset)* | Session cookie string for Direct Headless Mode |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | Default fallback model |
| `AIPASS_BRIDGE` | `http://127.0.0.1:8787` | Bridge URL for CLI clients |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | Format for tool/search events (`reasoning`, `text`, `off`) |

---

## 🧪 Tests

Run the test suite (37 tests):

```bash
bun test
# or
npm test
```

---

## ⚖️ Disclaimer & Compliance

- **Educational & Interoperability Purposes:** This project is an independent, open-source developer utility created solely for research, accessibility, and local interoperability purposes.
- **No Affiliation:** This project is not affiliated with, endorsed by, sponsored by, or connected with any proprietary third-party platform or service provider.
- **User Responsibility:** Users are strictly responsible for their own account usage and for complying with the applicable Terms of Service and local laws of any platform they interact with.
- **Privacy & Security:** This software does not collect, log, or forward user credentials or private data to any third-party servers. All operations remain strictly between your local client and your own authorized session.

---

## 📄 License
MIT




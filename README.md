# 🚀 AIPass Bridge

แปลง [de.aipass.net](https://de.aipass.net/chat) ให้กลายเป็น **Local / Remote AI Bridge Server** ที่ให้บริการในรูปแบบ **OpenAI-Compatible API** พร้อม Real-time Streaming, Server-side Web Search, Auto-Refresh Token และ Coding Agent

---

## 🌟 ฟีเจอร์เด่น (Key Features)

- 🔌 **OpenAI-Compatible API (`/v1/chat/completions`, `/v1/models`):** นำไปเชื่อมต่อกับ Cursor, VS Code (Cline / Roo Code / Aider), Open WebUI, Chatbox, Python/Node.js SDK ได้ทันที
- 🍪 **Direct Headless Mode (ผ่าน Cookie):** รันบนเซิร์ฟเวอร์แบบ Standalone 100% โดย **ไม่ต้องเปิด Browser ทิ้งไว้**
- 🔄 **Sliding Session Keep-Alive & Auto Cookie Refresh:** ยิง Heartbeat อัตโนมัติทุก 30 นาที และดักจับ Session Token ใหม่ลงดิสก์ ป้องกัน Cookie หมดอายุ
- 🧩 **Chrome Extension Mode:** รองรับการเชื่อมต่อผ่าน Chrome Extension สำหรับผู้ที่ต้องการให้ Browser จัดการสิทธิ์ความปลอดภัย
- ⚡ **Real-time SSE Streaming & Web Search:** รองรับการสตรีมข้อความแบบสดๆ และแสดงผลการค้นหาเว็บ (`web_search`) พร้อมแหล่งที่มา (Sources)
- 🤖 **Built-in Coding Agent (`bun run agent`):** AI Agent ในตัว ช่วยวิเคราะห์, ค้นหา, และเขียน/แก้ไขโค้ดในโปรเจกต์ได้อัตโนมัติ

---

## 🛠️ สถาปัตยกรรมการทำงาน (Architecture)

```
[ Terminal / API / Cursor / SDK ] 
            │ HTTP (OpenAI API Standard)
            ▼
┌────────────────────────────────────────────────────────┐
│               aipass bridge server (:8787)             │
│                                                        │
│  [โหมดที่ 1: Cookie Direct]     [โหมดที่ 2: Extension]  │
│  ยิงตรงผ่าน Session Cookie       เชื่อมต่อผ่าน SSE        │
│  + Auto Heartbeat 30m          ไปยัง de.aipass.net tab │
└───────────┬────────────────────────────────┬───────────┘
            │                                │
            ▼                                ▼
┌────────────────────────────────────────────────────────┐
│             https://de.aipass.net (AIPass API)         │
└────────────────────────────────────────────────────────┘
```

---

## 🚀 การเริ่มต้นใช้งาน (Quickstart)

### 1. ติดตั้ง Dependencies

```bash
bun install
# หรือ
npm install
```

---

## 🎯 เลือกรูปแบบการใช้งาน (Choose Operating Mode)

### รูปแบบที่ 1: Direct Headless Mode (แนะนำ - ปิด Browser ได้ 100%)

โหมดนี้เหมาะสำหรับรันบน Server หรือเครื่องที่ไม่ต้องการเปิดแท็บ Browser ค้างไว้

#### ขั้นตอนการตั้งค่า:
1. เปิดเว็บ [https://de.aipass.net/chat](https://de.aipass.net/chat) ในเบราว์เซอร์และเข้าสู่ระบบ
2. กด `F12` (Inspect) ไปที่แท็บ **Network** -> รีเฟรชหน้า 1 ครั้ง
3. คลิกที่ request ใดๆ (เช่น `list-models.data`) แล้วก๊อปปี้ค่าในส่วน **Request Headers -> `Cookie: ...`**
4. บันทึก Cookie ลงในไฟล์ `.cookie` หรือ `.env`:
   ```bash
   echo 'AIPASS_COOKIE="วาง_COOKIE_ที่ก๊อปมาตรงนี้"' > .env
   # หรือ
   echo "วาง_COOKIE_ที่ก๊อปมาตรงนี้" > .cookie
   ```
5. สั่งเริ่มรัน Server:
   ```bash
   AIPASS_HOST=0.0.0.0 bun dev
   ```
   *(หน้าจอจะขึ้น `mode : direct (AIPASS_COOKIE found, headless ready)` คุณสามารถ **ปิดเบราว์เซอร์ได้ทันที**)*

> 💡 **การอัปเดต Cookie แบบไม่ต้อง Restart:**  
> คุณสามารถส่ง Cookie ใหม่ผ่าน API ได้โดยตรง:  
> `curl -X POST http://localhost:8787/cookie -H "Content-Type: application/json" -d '{"cookie": "..."}'`

---

### รูปแบบที่ 2: Chrome Extension Mode (ผ่านเบราว์เซอร์)

โหมดนี้เหมาะสำหรับผู้ที่ต้องการความปลอดภัยสูง โดยให้เบราว์เซอร์เป็นตัวส่งคำขอและแนบ Session เอง

#### ขั้นตอนการตั้งค่า:
1. สั่งรัน Bridge Server:
   ```bash
   bun dev
   ```
2. เปิด Google Chrome แล้วไปที่ `chrome://extensions`
3. เปิดสวิตช์ **Developer mode** (มุมขวาบน)
4. กดปุ่ม **Load unpacked** แล้วเลือกโฟลเดอร์:
   ```text
   aipass-bridge/extension
   ```
5. เปิดแท็บ [https://de.aipass.net/chat](https://de.aipass.net/chat) ล็อกอินทิ้งไว้ และตรวจสอบว่าไอคอน Extension ขึ้นสถานะ **connected**

---

## 💬 การใช้งานผ่าน CLI (Terminal Usage)

### 1. แชทคุยกับ AI
```bash
# โหมดพิมพ์คุยโต้ตอบ (Interactive Chat)
bun run chat

# ถามคำถามด่วนรอบเดียวจบ (One-shot)
bun run chat -- "ช่วยสรุปข่าว AI ประจำวันนี้"

# สลับโมเดลที่ต้องการ
bun run chat -- --model claude-sonnet-5@default "สวัสดี"

# ชี้ไปยัง Bridge Server บนเครื่องอื่น / IP อื่น
bun run chat -- --bridge http://157.85.96.7:8787 "สวัสดี"
```

### 2. ดูโมเดลและประวัติการสนทนา
```bash
# ดูรายชื่อโมเดลทั้งหมด (มีแท็ก [free] สำหรับ gemini-3.1-flash-lite)
bun run models

# ดูประวัติบทสนทนา (Conversations)
bun run conversations
```

### 3. โหมด Coding Agent (อ่านและแก้ไขโค้ดอัตโนมัติ)
```bash
# ทดลองให้ Agent วิเคราะห์และแก้ไขโค้ด (Dry run - แสดง diff แต่ยังไม่เขียนลงไฟล์)
bun run agent -- "สร้าง route health check ใน express" --root .

# สั่งให้เขียนไฟล์จริงลงดิสก์
bun run agent -- "สร้าง route health check" --root . --apply
```

---

## ⚡ การใช้งานผ่าน OpenAI-Compatible API

คุณสามารถใช้ `curl`, Python, Node.js หรือโปรแกรมภายนอกยิงหา Endpoint ได้ทันที:

### ตัวอย่าง cURL (JSON Standard)
```bash
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-lite",
    "messages": [
      { "role": "user", "content": "1 + 1 ได้เท่าไหร่ ขอสั้นๆ" }
    ]
  }'
```

### ตัวอย่าง cURL (Real-time Streaming)
```bash
curl -N -s -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "stream": true,
    "model": "gemini-3.7-flash",
    "messages": [
      { "role": "user", "content": "ช่วยเล่าเรื่องสนุกๆ ให้ฟังหน่อย" }
    ]
  }'
```

### ตัวอย่าง Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="gemini-3.1-flash-lite",
    messages=[{"role": "user", "content": "สวัสดี!"}]
)

print(response.choices[0].message.content)
```

---

## 📋 ตัวอย่างโมเดลยอดนิยมที่รองรับ (Supported Models)

| Model ID | ชื่อโมเดล | ผู้ให้บริการ | จุดเด่น |
|---|---|---|---|
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | Google | 🟢 **[Free Credit]** ความเร็วสูง |
| `gemini-3.7-flash` | Gemini 3.7 Flash | Google | Hybrid Reasoning (Thinking) |
| `claude-sonnet-5@default` | Claude Sonnet 5 | Anthropic | ฉลาดรอบด้าน, เขียนโค้ดดีเยี่ยม |
| `claude-opus-5@azure` | Claude Opus 5 | Anthropic | โมเดลขนาดใหญ่ พลังประมวลผลสูง |
| `gpt-5.6-terra` | GPT-5.6 Terra | OpenAI | โมเดลตัวท็อปจาก OpenAI |
| `Kimi-K2.7-Code` | Kimi K2.7 Code | Moonshot AI | เชี่ยวชาญการเขียนโปรแกรม |
| `sonar-reasoning-pro` | Sonar Reasoning Pro | Perplexity | ค้นหาข้อมูลเว็บสด + เหตุผล |
| `pathumma-thaillm-8b` | Pathumma ThaiLLM 8B | Pathumma LLM | โมเดลภาษาไทย |

*(ดูรายชื่อทั้งหมด 20+ โมเดลได้จาก `bun run models` หรือ `GET /v1/models`)*

---

## ⚙️ ตัวแปรสภาพแวดล้อม (Environment Variables)

| ตัวแปร (Variable) | ค่าเริ่มต้น (Default) | คำอธิบาย |
|---|---|---|
| `AIPASS_PORT` | `8787` | พอร์ตที่ Bridge Server ให้บริการ |
| `AIPASS_HOST` | `127.0.0.1` | Host ที่จะ bind (ตั้ง `0.0.0.0` เพื่อเปิดให้ภายนอกเข้าถึงได้) |
| `AIPASS_COOKIE` | *(ว่าง)* | ค่า Session Cookie สำหรับรันโหมด Direct Headless |
| `AIPASS_MODEL` | `gemini-3.1-flash-lite` | โมเดลเริ่มต้นเมื่อไม่ได้ระบุ |
| `AIPASS_BRIDGE` | `http://127.0.0.1:8787` | URL ของ Bridge Server ที่ CLI จะชี้ไปหา |
| `AIPASS_TOOL_VISIBILITY` | `reasoning` | รูปแบบการส่งข้อมูล Tool/Search (`reasoning`, `text`, `off`) |

---

## 🧪 การทดสอบระบบ (Tests)

รันชุดทดสอบความถูกต้องและการทำงานทั้งหมด (37 tests):

```bash
bun test
# หรือ
npm test
```

---

## 📄 License
MIT

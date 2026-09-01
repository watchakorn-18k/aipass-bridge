import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, FakeExtension } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const post = (body) => fetch(`${bridge.base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function readStream(res) {
  const text = await res.text();
  const frames = text.split('\n\n')
    .map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter((d) => d && d !== '[DONE]')
    .map((d) => JSON.parse(d));
  return {
    content: frames.map((f) => f.choices?.[0]?.delta?.content ?? '').join(''),
    tool_calls: frames.find((f) => f.choices?.[0]?.delta?.tool_calls)?.choices?.[0]?.delta?.tool_calls,
    finish: frames.map((f) => f.choices?.[0]?.finish_reason).filter(Boolean).at(-1),
    done: text.includes('data: [DONE]'),
  };
}

test('emulates function calling in non-streaming response', async () => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      assert.match(job.text, /\[TOOLS INSTRUCTION\]/);
      assert.match(job.text, /get_weather/);
      await e.text('```json\n{\n  "name": "get_weather",\n  "arguments": {"location": "Bangkok"}\n}\n```');
      await e.done();
    },
  }).connect();

  const res = await post({
    messages: [{ role: 'user', content: 'What is the weather in Bangkok?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for location',
        parameters: { type: 'object', properties: { location: { type: 'string' } } },
      },
    }],
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.choices[0].finish_reason, 'tool_calls');
  assert.ok(data.choices[0].message.tool_calls);
  assert.equal(data.choices[0].message.tool_calls[0].function.name, 'get_weather');
  const args = JSON.parse(data.choices[0].message.tool_calls[0].function.arguments);
  assert.equal(args.location, 'Bangkok');
  await ext.disconnect();
});

test('emulates function calling in streaming response', async () => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      await e.text('```json\n{\n  "name": "get_weather",\n  "arguments": {"location": "Tokyo"}\n}\n```');
      await e.done();
    },
  }).connect();

  const res = await post({
    stream: true,
    messages: [{ role: 'user', content: 'Check Tokyo weather' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for location',
        parameters: { type: 'object', properties: { location: { type: 'string' } } },
      },
    }],
  });

  const out = await readStream(res);
  assert.equal(out.finish, 'tool_calls');
  assert.ok(out.tool_calls);
  assert.equal(out.tool_calls[0].function.name, 'get_weather');
  const args = JSON.parse(out.tool_calls[0].function.arguments);
  assert.equal(args.location, 'Tokyo');
  await ext.disconnect();
});

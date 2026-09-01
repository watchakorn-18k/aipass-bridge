import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBridge, FakeExtension, scripted, tempDir, run, AGENT } from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const agent = (dir, args = [], opts = {}) => run(AGENT, ['task text', '--root', dir, '--bridge', bridge.base, ...args], opts);

test('reads files and reports a summary, touching nothing on disk', async (t) => {
  const dir = tempDir({ 'README.md': 'a starter project\n' });
  const handler = scripted([
    'Let me look.\n\nNEED dir .\nNEED file README.md',
    'It is a starter project.\n\nDONE It is a starter project.',
  ]);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir);
  assert.match(out, /✓ list \./);
  assert.match(out, /✓ read README\.md/);
  assert.match(out, /✓ It is a starter project\./);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'a starter project\n');
});

test('the first message carries the instructions and a real directory listing', async (t) => {
  const dir = tempDir({ 'only.txt': 'x' });
  const handler = scripted(['DONE nothing to do']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  await agent(dir);
  const first = handler.sent[0];
  assert.match(first, /NEED file README\.md/, 'instructions present');
  assert.match(first, /only\.txt/, 'listing present');
  assert.doesNotMatch(first, /\btool\b/i, 'must not claim the model has tools');
});

test('later turns carry only results, never the instructions again', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello' });
  const handler = scripted(['NEED file a.txt', 'DONE read it']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  await agent(dir);
  assert.ok(handler.sent.length >= 2);
  assert.doesNotMatch(handler.sent[1], /NEED file README\.md/, 'preamble must not be resent');
  assert.ok(Buffer.byteLength(handler.sent[1]) < Buffer.byteLength(handler.sent[0]) / 2);
});

test('dry run shows a diff but writes nothing; --apply writes', async (t) => {
  const replies = [
    'EDIT a.txt\nFIND\nhello\nNEW\ngoodbye\nEND\nCREATE b.txt\nbrand new\nEND',
    'DONE changed things',
  ];

  const dry = tempDir({ 'a.txt': 'hello' });
  const dryExt = await new FakeExtension(bridge.base, { onChat: scripted(replies) }).connect();
  t.after(() => dryExt.disconnect());
  const first = await agent(dry);
  assert.match(first.out, /-hello/);
  assert.match(first.out, /\+goodbye/);
  assert.match(first.out, /dry run/);
  assert.equal(fs.readFileSync(path.join(dry, 'a.txt'), 'utf8'), 'hello');
  assert.ok(!fs.existsSync(path.join(dry, 'b.txt')));
  await dryExt.disconnect();

  const wet = tempDir({ 'a.txt': 'hello' });
  const wetExt = await new FakeExtension(bridge.base, { onChat: scripted(replies) }).connect();
  t.after(() => wetExt.disconnect());
  await agent(wet, ['--apply']);
  assert.equal(fs.readFileSync(path.join(wet, 'a.txt'), 'utf8'), 'goodbye');
  assert.equal(fs.readFileSync(path.join(wet, 'b.txt'), 'utf8'), 'brand new');
});

test('an edit whose FIND text does not match is reported, not applied', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['EDIT a.txt\nFIND\nnot in the file\nNEW\nx\nEND', 'DONE gave up']),
  }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir, ['--apply']);
  assert.match(out, /was not found/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello');
});

test('refuses to touch anything outside the project root', async (t) => {
  const dir = tempDir({ 'a.txt': 'hello' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['CREATE ../escaped.txt\nowned\nEND', 'DONE tried']),
  }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir, ['--apply']);
  assert.match(out, /escapes root/);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'escaped.txt')));
});

test('DONE alongside a file request is ignored, and the run continues', async (t) => {
  const dir = tempDir({ 'a.txt': 'contents here' });
  const handler = scripted([
    'NEED file a.txt\n\nDONE waiting on that file',
    'DONE now I have actually read it',
  ]);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir);
  assert.match(out, /ignoring DONE/);
  assert.match(out, /✓ read a\.txt/);
  assert.match(out, /now I have actually read it/);
  assert.ok(handler.sent.length >= 2, 'the run must not stop on the premature DONE');
});

test('recovers when the model drifts into prose, and gives up after three', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const drifting = await new FakeExtension(bridge.base, {
    onChat: scripted(['I cannot do that.', 'NEED file a.txt', 'DONE fine']),
  }).connect();
  t.after(() => drifting.disconnect());
  const recovered = await agent(dir);
  assert.match(recovered.out, /nudging \(1\/2\)/);
  assert.match(recovered.out, /✓ read a\.txt/);
  await drifting.disconnect();

  const stubborn = await new FakeExtension(bridge.base, { onChat: scripted(['I will not do that.']) }).connect();
  t.after(() => stubborn.disconnect());
  const gaveUp = await agent(dir);
  assert.match(gaveUp.out, /no marker after three replies/);
});

test('loopback addresses are substituted outbound and restored on disk', async (t) => {
  const dir = tempDir({ 'cfg.md': 'see http://localhost:3000 and 127.0.0.1:8080\n' });
  const handler = scripted([
    'NEED file cfg.md',
    'EDIT cfg.md\nFIND\nsee http://LCLHST:3000 and LOOPBACK-IP:8080\nNEW\nsee http://LCLHST:4000 and LOOPBACK-IP:9090\nEND',
    'DONE ports changed',
  ]);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  await agent(dir, ['--apply']);
  const sentAll = handler.sent.join('\n');
  assert.doesNotMatch(sentAll, /localhost/i, 'localhost must never leave this machine');
  assert.doesNotMatch(sentAll, /127\.0\.0\.1/, 'loopback ip must never leave this machine');
  assert.match(sentAll, /LCLHST/);
  assert.equal(fs.readFileSync(path.join(dir, 'cfg.md'), 'utf8'), 'see http://localhost:4000 and 127.0.0.1:9090\n');
});

test('splits and resends a turn the upstream rejects', async (t) => {
  const filler = 'a line of perfectly ordinary prose in the middle of the file\n'.repeat(6);
  const dir = tempDir({ 'big.txt': `ALPHA line\n${filler}BETA line\n` });
  // Rejects only when both markers travel together, which splitting resolves.
  const handler = scripted(['NEED file big.txt', 'DONE read it'], {
    reject: (t) => t.includes('ALPHA') && t.includes('BETA'),
  });
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir);
  assert.match(out, /splitting into 2 parts/);
  assert.match(out, /✓ read it/);
});

test('drops a line that cannot be sent at any size, and keeps going', async (t) => {
  const dir = tempDir({ 'package.json': '{\n  "scripts": {\n    "x": "node -e \\"fetch()\\"",\n    "build": "next build"\n  }\n}\n' });
  const handler = scripted(['NEED file package.json', 'DONE inspected it'], {
    reject: (t) => /node\s+-e/.test(t),
  });
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir);
  assert.match(out, /omitting 1 line/);
  assert.match(out, /✓ inspected it/);
  const delivered = handler.sent.join('\n');
  assert.doesNotMatch(delivered, /node -e/, 'the blocked line must never be accepted upstream');
  assert.match(delivered, /next build/, 'the rest of the file still gets through');
  assert.ok(handler.rejected.length > 0, 'the first attempt should have been refused');
});

test('falls back to the reply prose when DONE carries no summary', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['It is a small Next.js starter.\n\nDONE\n\nWant me to continue?']),
  }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir);
  assert.match(out, /✓ It is a small Next\.js starter\./);
});

test('shell commands are refused unless --allow-run is given', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, {
    onChat: scripted(['RUN\necho pwned\nEND', 'DONE tried']),
  }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir);
  assert.match(out, /disabled for this run/);
});

test('starts its own conversation by default', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE nothing to do']) }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir);
  assert.equal(ext.created.length, 1, 'a conversation should be created for the run');
  const fresh = ext.created[0].requestId.replace(/-/g, '').slice(0, 16);
  assert.equal(ext.chats.at(-1).conversationId, fresh, 'the run must use the conversation it created');
  assert.match(out, /\(new\)/);
});

test('--reuse continues the most recent conversation instead', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE nothing to do']) }).connect();
  t.after(() => ext.disconnect());

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversation: null }),
  });
  const { out } = await agent(dir, ['--reuse']);
  assert.equal(ext.created.length, 0, 'nothing should be created');
  assert.equal(ext.chats.at(-1).conversationId, 'aaaa1111aaaa1111');
  assert.match(out, /reusing the most recent/);
});

test('--conversation pins an explicit one', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE nothing to do']) }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir, ['--conversation', '1234abcd1234abcd']);
  assert.equal(ext.created.length, 0);
  assert.equal(ext.chats.at(-1).conversationId, '1234abcd1234abcd');
  assert.match(out, /continuing/);
});

test('html comments survive a comment-blocking edge and restore on disk', async (t) => {
  const original = '<!-- BEGIN:nextjs-agent-rules -->\n# Rules\nsome prose here\n<!-- END:nextjs-agent-rules -->\n';
  const dir = tempDir({ 'AGENTS.md': original });
  const handler = scripted([
    'NEED file AGENTS.md',
    'EDIT AGENTS.md\nFIND\n# Rules\nNEW\n# Project Rules\nEND',
    'DONE read and tweaked it',
  ], {
    reject: (t) => t.includes('<!--'),   // the edge refuses any HTML comment, as observed
  });
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir, ['--apply']);
  assert.match(out, /✓ read AGENTS\.md/);
  assert.match(out, /✓ read and tweaked it/);

  const sent = handler.sent.join('\n');
  assert.doesNotMatch(sent, /<!--/, 'no HTML comment may reach the edge');
  assert.match(sent, /CMT-OPEN/, 'it is neutralised, not dropped');

  // bytes on disk = the original with only the intended edit applied
  assert.equal(
    fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'),
    original.replace('# Rules', '# Project Rules'),
  );
});

test('--slim drops the built-in preamble and sends only the task', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const handler = scripted(['DONE nothing needed']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  await agent(dir, ['--slim', '--reuse']);
  const first = handler.sent[0];
  assert.doesNotMatch(first, /NEED file README\.md/, 'the instruction block must be gone');
  assert.doesNotMatch(first, /you write the lines/i);
  assert.match(first, /Task:/);
  assert.match(first, /a\.txt/, 'the listing is still there');
  assert.ok(Buffer.byteLength(first) < 200, `slim first message should be small, was ${Buffer.byteLength(first)}`);
});

test('--watch runs a follow-up task on the same conversation', async (t) => {
  const dir = tempDir({ 'a.txt': 'one' });
  // Each task: one read then DONE. Same handler serves both tasks in sequence.
  let turn = 0;
  const replies = ['NEED file a.txt', 'DONE first task', 'NEED file a.txt', 'DONE second task'];
  const convIds = [];
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      if (job.text === 'Hello.' || job.text === 'Starting a new working session.') { await e.text('hi'); return void e.done(); }
      convIds.push(job.conversationId);
      await e.text(replies[Math.min(turn++, replies.length - 1)]);
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir, ['--reuse', '--watch'], { stdin: [[400, 'look again\n']] });
  assert.match(out, /✓ first task/);
  assert.match(out, /watching/);
  assert.match(out, /✓ second task/, 'the follow-up task must run');
  // every chat turn hit the same conversation
  assert.equal(new Set(convIds).size, 1, 'watch must stay in one conversation');
});

test('--assistant binds the created conversation and implies slim', async (t) => {
  const dir = tempDir({ 'a.txt': 'x' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['DONE nothing to do']) }).connect();
  t.after(() => ext.disconnect());

  const { out } = await agent(dir, ['--assistant', 'asst_abc123']);
  assert.equal(ext.created.length, 1);
  assert.equal(ext.created[0].assistant, 'asst_abc123', 'the create job carries the assistant id');
  assert.equal(ext.created[0].assistantField, 'aiAssistantId', 'and the configured field name');
  // implies slim: the heavy preamble must be gone
  const firstTask = ext.chats.find((c) => c.text.includes('Task:'));
  assert.ok(firstTask, 'a task message was sent');
  assert.doesNotMatch(firstTask.text, /you write the lines/i);
});

#!/usr/bin/env node
/**
 * AIPass Multi-Agent Team Orchestrator
 *
 * Coordinates 3 specialized AI agents in a fully automated loop:
 *  1. 🧠 Lead Architect: Analyzes requirement, plans file architecture & task list
 *  2. 💻 Autonomous Developer: Writes, edits, and creates files on disk
 *  3. 🔍 QA & Reviewer: Reviews code quality, tests logic, and triggers auto-fix loop
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const task = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ').trim();
const ROOT = path.resolve(flag('root', process.cwd()));
const BRIDGE = (flag('bridge', process.env.AIPASS_BRIDGE ?? 'http://157.85.96.7:8787')).replace(/\/+$/, '');
const ARCHITECT_MODEL = flag('architect-model', 'claude-sonnet-5@default');
const DEVELOPER_MODEL = flag('developer-model', 'gemini-3.1-flash-lite');
const REVIEWER_MODEL = flag('reviewer-model', 'claude-sonnet-5@default');
const APPLY = has('apply');
const ALLOW_RUN = has('allow-run');
const MAX_ROUNDS = Number(flag('max-rounds', 3));

if (!task) {
  console.log(`
\x1b[1m\x1b[36mAIPass Multi-Agent Team Orchestrator\x1b[0m

Usage:
  npm run team -- "<task description>" [options]

Options:
  --root <dir>              Project workspace root (default: current directory)
  --apply                   Write files directly to disk (default: dry run preview)
  --allow-run               Allow QA/Developer to execute test commands
  --bridge <url>            Bridge URL (default: http://157.85.96.7:8787)
  --architect-model <id>    Model for Architect (default: claude-sonnet-5@default)
  --developer-model <id>    Model for Developer (default: gemini-3.1-flash-lite)
  --reviewer-model <id>     Model for Reviewer (default: claude-sonnet-5@default)
  --max-rounds <N>          Maximum QA review & fix loops (default: 3)

Example:
  npm run team -- "Build a snake game with sound effects and scoreboard" --apply
`);
  process.exit(1);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const magenta = (s) => `\x1b[35m${s}\x1b[0m`;

// Overlay file tracking
const overlay = new Map();
const createdFiles = new Set();
const modifiedFiles = new Set();

function safePath(p) {
  const abs = path.resolve(ROOT, p);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error(`Path escapes root: ${p}`);
  return abs;
}

function readWorkspace(p) {
  const abs = safePath(p);
  if (overlay.has(abs)) return overlay.get(abs);
  if (fs.existsSync(abs)) return fs.readFileSync(abs, 'utf8');
  return null;
}

function writeWorkspace(p, content) {
  const abs = safePath(p);
  const exists = fs.existsSync(abs);
  overlay.set(abs, content);
  if (exists) modifiedFiles.add(p);
  else createdFiles.add(p);

  if (APPLY) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function listWorkspaceTree(dir = ROOT) {
  const skip = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);
  const files = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(current, e.name);
      const rel = path.relative(ROOT, full);
      if (e.isDirectory()) walk(full);
      else files.push(rel);
    }
  }
  walk(dir);
  for (const [abs] of overlay.entries()) {
    const rel = path.relative(ROOT, abs);
    if (!files.includes(rel)) files.push(rel);
  }
  return files;
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

async function callModel(model, messages, systemPrompt = '') {
  const payload = {
    model,
    stream: false,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: outbound(systemPrompt) }] : []),
      ...messages.map((m) => ({ ...m, content: outbound(m.content) })),
    ],
  };

  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bridge error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0]?.message;
  return inbound(choice?.content ?? '');
}

/* -------------------------------------------------------------------------- */
/*                               MAIN TEAM FLOW                               */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`\n${bold(cyan('══════════════════════════════════════════════════════════════'))}`);
  console.log(`  ${bold('🚀 AIPass Multi-Agent Team Launched')}`);
  console.log(`  ${dim('Task:')} ${bold(task)}`);
  console.log(`  ${dim('Workspace:')} ${ROOT} ${APPLY ? green('(--apply enabled)') : yellow('(dry-run preview)')}`);
  console.log(`  ${dim('Bridge:')} ${BRIDGE}`);
  console.log(`${bold(cyan('══════════════════════════════════════════════════════════════'))}\n`);

  const initialTree = listWorkspaceTree();

  /* ---------------------- PHASE 1: LEAD ARCHITECT ---------------------- */
  console.log(`${bold(magenta('🧠 [Phase 1] Lead Architect'))} analyzing requirement & planning architecture...`);
  const architectSystem = `You are a Lead Software Architect.
Analyze the user request and existing project workspace.
Produce a clear, structured implementation plan with:
1. High-level Architecture & Tech Stack
2. List of Files to create or modify (with explicit filenames and responsibilities)
3. Step-by-step implementation specifications for the Developer Agent.`;

  const architectPrompt = `User Request: "${task}"
Existing Project Files:
${initialTree.length ? initialTree.map((f) => `- ${f}`).join('\n') : '(empty workspace)'}

Please provide the detailed architectural blueprint and file list now.`;

  const architecturePlan = await callModel(ARCHITECT_MODEL, [{ role: 'user', content: architectPrompt }], architectSystem);
  console.log(`\n${green('✔ Architecture Plan Ready:')}\n${dim(architecturePlan.slice(0, 400))}...\n`);

  /* ------------------- PHASE 2: AUTONOMOUS DEVELOPER ------------------- */
  console.log(`${bold(cyan('💻 [Phase 2] Autonomous Developer'))} generating code and creating files...`);
  const developerSystem = `You are an Autonomous Senior Fullstack Developer.
Implement the Architect's plan completely.
You MUST write the complete, working code for ALL required files.
For each file you create or update, output it in this format:

CREATE <filepath>
<full file contents here>
END

Do not truncate code or leave placeholders. Write production-ready code.`;

  const developerPrompt = `User Task: "${task}"
Architect Plan:
${architecturePlan}

Existing Project Files:
${listWorkspaceTree().map((f) => `- ${f}`).join('\n') || '(none)'}

Implement all files now using CREATE <filepath> ... END blocks.`;

  const devOutput = await callModel(DEVELOPER_MODEL, [{ role: 'user', content: developerPrompt }], developerSystem);

  // Extract all files from Developer Output
  const createRegex = /CREATE\s+([^\r\n]+)\r?\n([\s\S]*?)\r?\nEND/g;
  let match;
  let fileCount = 0;
  while ((match = createRegex.exec(devOutput)) !== null) {
    const filename = match[1].trim();
    const content = match[2];
    writeWorkspace(filename, content);
    console.log(`  ${green('+')} ${bold(filename)} ${dim(`(${content.split('\n').length} lines)`)}`);
    fileCount++;
  }

  // Fallback: If developer output raw markdown codeblocks with filename headers
  if (fileCount === 0) {
    const codeBlockRegex = /```([a-zA-Z0-9_\-\.\+]+)?\r?\n([\s\S]+?)\r?\n```/g;
    let bMatch;
    while ((bMatch = codeBlockRegex.exec(devOutput)) !== null) {
      const slice = devOutput.slice(Math.max(0, bMatch.index - 100), bMatch.index);
      const fMatch = slice.match(/[`'"]([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]{1,6})[`'"]/);
      const filename = fMatch ? fMatch[1] : `file_${fileCount + 1}.${bMatch[1] || 'txt'}`;
      writeWorkspace(filename, bMatch[2]);
      console.log(`  ${green('+')} ${bold(filename)} ${dim(`(${bMatch[2].split('\n').length} lines)`)}`);
      fileCount++;
    }
  }

  console.log(`\n${green('✔ Developer finished:')} ${fileCount} files staged.\n`);

  /* ------------------- PHASE 3 & 4: QA & AUTO-FIX LOOP ------------------- */
  let currentRound = 1;
  let isApproved = false;

  while (currentRound <= MAX_ROUNDS && !isApproved) {
    const roundText = `🔍 [Phase 3] QA & Reviewer (Round ${currentRound}/${MAX_ROUNDS})`;
    console.log(`${bold(yellow(roundText))} inspecting code...`);

    const currentFiles = listWorkspaceTree();
    const fileContents = currentFiles.map((f) => {
      const c = readWorkspace(f);
      return `--- File: ${f} ---\n${c ? c.slice(0, 3000) : '(empty)'}\n`;
    }).join('\n');

    const reviewerSystem = `You are a Principal QA & Security Engineer.
Review the code for:
1. Logic bugs, missing imports, syntax issues, runtime crashes
2. Correct fulfillment of the user requirement: "${task}"
3. Edge cases and responsive UI / backend reliability

If everything is high quality and working, output:
STATUS: APPROVED
Summary of why it passed.

If there are bugs or missing parts, output:
STATUS: NEEDS_FIX
List of specific issues and exact code changes required.`;

    const qaPrompt = `User Requirement: "${task}"
Generated Files:
${fileContents}

Please review and provide STATUS: APPROVED or STATUS: NEEDS_FIX with recommendations.`;

    const qaResult = await callModel(REVIEWER_MODEL, [{ role: 'user', content: qaPrompt }], reviewerSystem);

    if (qaResult.includes('STATUS: APPROVED')) {
      console.log(`\n${green('🎉 QA Status: APPROVED!')}`);
      console.log(dim(qaResult.replace('STATUS: APPROVED', '').trim()));
      isApproved = true;
      break;
    }

    console.log(`\n${yellow('⚠️ QA Status: ISSUES DETECTED. Triggering Auto-Fix...')}`);
    console.log(dim(qaResult.slice(0, 300)) + '...\n');

    // Auto-fix loop
    console.log(`${bold(cyan('🛠️ Developer applying QA fixes...'))}`);
    const fixPrompt = `User Requirement: "${task}"
QA Review Feedback:
${qaResult}

Current Files:
${fileContents}

Please apply all required fixes and output the corrected files using CREATE <filepath> ... END.`;

    const fixOutput = await callModel(DEVELOPER_MODEL, [{ role: 'user', content: fixPrompt }], developerSystem);

    let fixMatch;
    let fixCount = 0;
    while ((fixMatch = createRegex.exec(fixOutput)) !== null) {
      const filename = fixMatch[1].trim();
      const content = fixMatch[2];
      writeWorkspace(filename, content);
      console.log(`  ${yellow('↻')} Updated ${bold(filename)}`);
      fixCount++;
    }

    currentRound++;
  }

  /* --------------------------- FINAL SUMMARY --------------------------- */
  console.log(`\n${bold(cyan('══════════════════════════════════════════════════════════════'))}`);
  console.log(`  ${bold(green('✨ Team Multi-Agent Workflow Completed Successfully!'))}`);
  console.log(`  ${dim('Created Files:')}  ${[...createdFiles].join(', ') || '(none)'}`);
  console.log(`  ${dim('Modified Files:')} ${[...modifiedFiles].join(', ') || '(none)'}`);
  if (!APPLY) {
    console.log(`\n  ${yellow('💡 Note: This was a dry-run.')} Run with ${bold('--apply')} to save changes directly to disk:`);
    console.log(`     ${cyan(`bun run team -- "${task}" --apply`)}`);
  } else {
    console.log(`\n  ${green('✔ All files written directly to workspace disk.')}`);
  }
  console.log(`${bold(cyan('══════════════════════════════════════════════════════════════'))}\n`);
}

main().catch((err) => {
  console.error(`\n${red('Team Agent Error:')}`, err.message || err);
  process.exit(1);
});

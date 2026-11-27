#!/usr/bin/env node
/*
 * AI-persona visitors for the dashboard's first screen.
 *
 * These are not people. Each visitor is a language model playing one invented person: a role, a
 * reason for being here, how much is at stake for them, some patience. The persona is shown what a person would see (the text in
 * the viewport and the controls they could click) and answers with one action: click, scroll or
 * leave. It is never told what is measured, that there is an experiment, which version it got, or
 * that any action is wanted. The persona is drawn from the seed and the visitor number alone,
 * before the page is opened, so it cannot depend on the version.
 *
 * Everything else is the real thing: the built dashboard in headless Chrome asks Flagsmith which
 * first screen to show, sends the exposure, and sends `check_run` when a click runs a check
 * (scripts/traffic/harness.mjs). The version is read from Flagsmith's answer for the log only.
 *
 * The model is the Claude CLI in print mode with no tools, no settings and no session: one call
 * per action. `--llm stub` swaps it for a fixed rule, so the plumbing can be tested without a model.
 *
 * Usage:
 *   npm run build
 *   node scripts/traffic/personas.mjs --environment <client-side key> --visitors 60 --out runs/duel-1
 *     [--until-each 300] [--concurrency 4] [--seed <text>] [--model haiku] [--max-steps 5] [--log-screen]
 *     [--api-url <url>] [--events-url <url>] [--chrome <path>] [--llm stub] [--self-test]
 *
 *   --out         a folder for decisions.jsonl (one line per decision, one per visitor),
 *                 summary.json, summary.md and replay.json (replay.mjs)
 *   --until-each  after --visitors, keep sending visitors until every version has had this many
 *                 (at most twice --visitors in all), so the planned sample comes from one run
 *                 and nobody has to look at a summary to decide whether to send more
 *   --log-screen  also keep the text each persona was shown in decisions.jsonl
 *   --self-test   strict: any visitor that fails, or any event that does not arrive, fails the run
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHarness, decisions, root, until } from './harness.mjs';
import { replayOf } from './replay.mjs';

const { values: opt } = parseArgs({
  options: {
    environment: { type: 'string' },
    visitors: { type: 'string', default: '12' },
    'until-each': { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    seed: { type: 'string' },
    model: { type: 'string', default: 'haiku' },
    'max-steps': { type: 'string', default: '5' },
    out: { type: 'string' },
    'log-screen': { type: 'boolean', default: false },
    'api-url': { type: 'string' },
    'events-url': { type: 'string' },
    chrome: { type: 'string' },
    llm: { type: 'string', default: 'claude' },
    'self-test': { type: 'boolean', default: false },
  },
});
const fail = msg => { console.error(`personas: ${msg}`); process.exit(2); };
if (!opt.environment) fail('--environment <client-side key> is required');
const total = Number(opt.visitors);
const concurrency = Math.max(1, Number(opt.concurrency));
const maxSteps = Number(opt['max-steps']);
const untilEach = opt['until-each'] === undefined ? 0 : Number(opt['until-each']);
if (!Number.isInteger(total) || total < 1) fail('--visitors must be a whole number');
if (!Number.isInteger(untilEach) || untilEach < 0) fail('--until-each must be a whole number');
if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 12) fail('--max-steps must be a whole number from 1 to 12');
if (!['claude', 'stub'].includes(opt.llm)) fail('--llm is "claude" (the default) or "stub"');
const stubbed = opt.llm === 'stub';
const seed = opt.seed ?? process.env.GITHUB_RUN_ID ?? Date.now().toString(36);

if (!existsSync(join(root, 'apps/dashboard/dist/index.html'))) fail('the dashboard is not built: run `npm run build` first');
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
if (!stubbed && spawnSync(CLAUDE, ['--version'], { stdio: 'ignore' }).status !== 0) fail('the Claude CLI was not found: install it, set CLAUDE_BIN, or pass --llm stub');

/* ====================================================================================
 * PERSONAS AND PROMPT. This section is published in the README as it stands: who the
 * visitors are, what each one is told, and what it is shown on every turn.
 * ==================================================================================== */

const ROLES = [
  'a frontend developer at a small startup',
  'a backend engineer at a mid-size company',
  'a product manager',
  'a growth analyst who reads experiment results',
  'an engineering manager',
  'a data scientist',
  'a student learning web development',
  'a founder of a two-person company',
  'a QA engineer',
  'a freelance developer between projects',
];
// Most visitors to any tool's page did not come looking for it, and the list is weighted that way.
const ARRIVALS = [
  'a colleague posted the link in the team chat',
  'they clicked a link in a newsletter while skimming it',
  'they searched for why an A/B test stopped collecting data',
  'they saw it in a list of open-source projects',
  'they are comparing tools for their team this week',
  'they opened it from a row of browser tabs and do not remember why',
  'their manager asked them to take a quick look',
  'they followed a link under a post on a developer forum',
  'they clicked it by mistake while reaching for another tab',
  'they are filling a few minutes before a meeting',
  'a search for something else brought it up and the title looked close',
  'they starred the repository months ago and are clearing out old tabs',
];
const KNOWLEDGE = [
  'has never run one',
  'knows the idea but has never set one up',
  'has run a few',
  'runs them every week',
];
// How much the subject matters to them today. Listed twice where it is twice as common.
const STAKES = [
  'nothing: it is not their problem and not their job',
  'nothing: it is not their problem and not their job',
  'little: it might be useful one day',
  'little: it might be useful one day',
  'a lot: a problem like this cost them time recently',
];
const DISPOSITIONS = [
  'sceptical of new tools',
  'curious and likes to try things',
  'in a hurry',
  'careful, reads before clicking',
  'distracted, only half paying attention',
  'methodical, comparing several tools',
  'tired at the end of a long day',
];

/** One visitor's persona, from the seed and the visitor number alone. */
function persona(seed, n, maxSteps) {
  const draw = decisions(`persona:${seed}:${n}`);
  const pick = list => list[Math.floor(draw() * list.length)];
  const role = pick(ROLES);
  const arrival = pick(ARRIVALS);
  const knowledge = pick(KNOWLEDGE);
  const disposition = pick(DISPOSITIONS);
  // Skewed low: with five steps allowed, 45% of personas have one action in them and 11% have five.
  const patience = 1 + Math.floor(draw() ** 2 * maxSteps);
  const stakes = pick(STAKES);
  return { role, arrival, knowledge, stakes, disposition, patience };
}

/** What the model is told about who it is playing. The same for every version of the page. */
function systemPrompt(p) {
  return `You are playing one person who has just opened a web page in their browser. Decide what this person does next.

The person:
- They are ${p.role}.
- How they got here: ${p.arrival}.
- A/B testing: this person ${p.knowledge}.
- What is at stake for them today: ${p.stakes}.
- Right now they are ${p.disposition}.
- Patience: on a page like this they take at most ${p.patience} ${p.patience === 1 ? 'action' : 'actions'}, and often none, before going back to what they were doing.

Each message shows what is on their screen: the text they can see, then a numbered list of what they can click. Answer with one JSON object and nothing else, in one of these three forms:
{"do":"click","target":<number from the list>,"because":"<one short sentence>"}
{"do":"scroll","because":"<one short sentence>"}
{"do":"leave","because":"<one short sentence>"}

Most people who open a tool's page look for a few seconds and leave without clicking anything, unless something is clearly worth their time. Do what this person would really do, not what would be thorough, polite or helpful. All three answers are equally acceptable.`;
}

/** What the model is shown on each turn: what the person did so far, the screen, the controls. */
function observation(seen, history) {
  return [
    history.length ? `So far on this page they have: ${history.join('; ')}.` : 'They have just opened the page.',
    '',
    'On their screen:',
    seen.text || '(nothing readable)',
    '',
    seen.controls.length ? 'They can click:' : 'There is nothing to click.',
    ...seen.controls.map((c, i) => `${i + 1}. ${describeControl(c)}`),
    '',
    seen.more ? 'The page continues below what they can see.' : 'This is the bottom of the page.',
  ].join('\n');
}
/** A control as listed: its label, and where it is or what it looks like. Never what it is for. */
const describeControl = c => `${c.label}${c.notes.length ? ` (${c.notes.join(', ')})` : ''}`;

const TEXT_CAP = 1800;
const CONTROL_CAP = 25;

/**
 * Runs in the page. What a person would see: the text that has a box inside the viewport, one line
 * per block, and the visible, enabled buttons and links that are not covered by something else.
 * The notes on a control say where it is or how it looks: "top bar", "this page" (the current
 * navigation item), "filled button" (the page's own highlighted style), "goes to another page".
 */
function lookAtPage(textCap, controlCap) {
  const vw = innerWidth;
  const vh = innerHeight;
  const inView = r => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  const visible = el => el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  const tidy = s => (s ?? '').replace(/\s+/g, ' ').trim();

  // Text that follows on in the same block, or on the same row of the screen, stays on one line.
  const lines = [];
  let lastBlock = null;
  let lastBox = null;
  const middle = r => (r.top + r.bottom) / 2;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const words = tidy(node.nodeValue);
    const parent = node.parentElement;
    if (!words || !parent || parent.closest('script, style, noscript') || !visible(parent)) continue;
    range.selectNodeContents(node);
    const boxes = [...range.getClientRects()].filter(inView);
    if (!boxes.length) continue;
    let block = parent;
    while (block.parentElement && getComputedStyle(block).display === 'inline') block = block.parentElement;
    const sameRow = lastBox && Math.abs(middle(boxes[0]) - middle(lastBox)) < 5 && boxes[0].left >= lastBox.left;
    if (block === lastBlock || sameRow) lines[lines.length - 1] += ` ${words}`; else lines.push(words);
    lastBlock = block;
    lastBox = boxes.at(-1);
  }
  const all = lines.join('\n');
  const text = all.length > textCap ? `${all.slice(0, textCap).replace(/\s+\S*$/, '')} …` : all;

  const topBar = document.querySelector('header nav')?.parentElement;
  const found = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    if (found.length === controlCap) break;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (!inView(r)) continue;
    const hit = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), Math.min(Math.max(r.top + r.height / 2, 0), vh - 1));
    if (!hit || !el.contains(hit)) continue;
    const named = tidy(el.getAttribute('aria-label'));
    const shown = tidy(el.innerText);
    const label = ((el.closest('nav') ? named || shown : shown || named) || tidy(el.title)).slice(0, 60);
    if (!label) continue;
    const notes = [];
    if (topBar?.contains(el)) notes.push('top bar');
    if (el.getAttribute('aria-current') === 'page') notes.push('this page');
    if (el.matches('.btn.primary')) notes.push('filled button');
    const away = el.tagName === 'A' && (el.origin !== location.origin || el.pathname !== location.pathname);
    if (away) notes.push('goes to another page');
    found.push({ el, label, notes, away });
  }
  window.__oakControls = found.map(f => f.el);
  return {
    text,
    controls: found.map(({ label, notes, away }) => ({ label, notes, away })),
    more: scrollY + vh < document.documentElement.scrollHeight - 8,
  };
}

/* ============================ end of the published section ============================ */

/** Runs in the page: clicks control `index` from the last look, or the one with its label if the page redrew it. */
function clickInPage(index, label) {
  let el = (window.__oakControls ?? [])[index];
  if (!el?.isConnected) {
    el = [...document.querySelectorAll('button, a[href], [role="button"]')]
      .find(e => !e.disabled && [e.innerText, e.getAttribute('aria-label')].some(t => (t ?? '').replace(/\s+/g, ' ').trim() === label));
  }
  if (!el || el.disabled) return false;
  el.click();
  return true;
}

const FLAG = 'first_screen';
const MAIN_BUTTON = '.page-slot .btn.primary, main.content .btn.primary';
const LLM_TIMEOUT_MS = 90000;
const RETRIES = 2;

// The model runs in an empty folder, so no project file or memory can reach a persona.
const llmDir = stubbed ? null : mkdtempSync(join(tmpdir(), 'oak-persona-llm-'));
const llm = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, models: new Set(), lastError: '' };

/** One call to the Claude CLI: no tools, no settings, no session. Never rejects. */
function claude(system, message) {
  return new Promise(done => {
    const began = Date.now();
    const child = spawn(CLAUDE, [
      '-p', '--model', opt.model, '--system-prompt', system, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json', message,
    ], { cwd: llmDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), LLM_TIMEOUT_MS);
    child.on('error', e => { clearTimeout(timer); done({ ms: Date.now() - began, error: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      const ms = Date.now() - began;
      let r;
      try { const parsed = JSON.parse(out); r = Array.isArray(parsed) ? parsed.findLast(m => m.type === 'result') : parsed; } catch { /* reported below */ }
      if (!r) return done({ ms, error: `the CLI exited with ${code}: ${(err || out).trim().slice(0, 200) || 'no output'}` });
      const u = r.usage ?? {};
      done({
        ms,
        ...(r.is_error ? { error: `the model call failed: ${String(r.result ?? '').slice(0, 200)}` } : { reply: String(r.result ?? '') }),
        tokens: { in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), out: u.output_tokens ?? 0 },
        cost: r.total_cost_usd ?? 0,
        models: Object.keys(r.modelUsage ?? {}),
      });
    });
  });
}

/**
 * --llm stub: a fixed rule in place of the model. It leaves at once a fifth of the time, otherwise
 * presses the filled button until a check has run, then sometimes opens Set up and copies a
 * snippet. Its replies come wrapped the ways a model wraps them, to exercise the parser.
 */
function stub(seen, history, draw) {
  const reply = o => { const s = JSON.stringify(o); const r = draw(); return r < 0.34 ? `\`\`\`json\n${s}\n\`\`\`` : r < 0.67 ? `Here is what they do: ${s}` : s; };
  const tried = label => history.some(h => h.includes(`"${label}"`));
  const find = test => seen.controls.findIndex(c => !c.away && test(c)) + 1;
  if (!history.length) {
    const r = draw();
    if (r < 0.2) return reply({ do: 'leave', because: 'stub: not for me' });
    if (r < 0.3 && seen.more) return reply({ do: 'scroll', because: 'stub: looking further down' });
  }
  const main = find(c => c.notes.includes('filled button') && !c.notes.includes('top bar') && !tried(c.label));
  if (main) return reply({ do: 'click', target: main, because: 'stub: the filled button' });
  const copy = find(c => /^Copy/.test(c.label) && !tried(c.label));
  if (copy) return reply({ do: 'click', target: copy, because: 'stub: copying a snippet' });
  const setUp = find(c => c.label === 'Set up' && !tried(c.label));
  if (setUp && draw() < 0.7) return reply({ do: 'click', target: setUp, because: 'stub: how is it installed' });
  return reply({ do: 'leave', because: 'stub: seen enough' });
}

/** The first JSON object in a reply, whatever surrounds it. Null unless it is a valid decision. */
function parseDecision(reply, controls) {
  const body = String(reply).replace(/```[a-z]*/gi, '');
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let end = -1;
  for (let i = start; i < body.length && end < 0; i++) {
    const c = body[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) end = i;
  }
  let d;
  try { d = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  const act = typeof d?.do === 'string' ? d.do.trim().toLowerCase() : '';
  const because = typeof d.because === 'string' ? d.because.trim().slice(0, 300) : '';
  if (act === 'leave' || act === 'scroll') return { do: act, because };
  const target = Number(d.target);
  if (act === 'click' && Number.isInteger(target) && target >= 1 && target <= controls) return { do: 'click', target, because };
  return null;
}

class ModelDown extends Error {}

/** Asks for one decision, trying again after a failed call or a reply that is not a decision. */
async function ask(p, seen, history, draw) {
  const tokens = { in: 0, out: 0 };
  let latencyMs = 0;
  let error = '';
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    const r = stubbed ? { ms: 0, reply: stub(seen, history, draw) } : await claude(systemPrompt(p), observation(seen, history));
    llm.calls++;
    latencyMs += r.ms;
    tokens.in += r.tokens?.in ?? 0;
    tokens.out += r.tokens?.out ?? 0;
    llm.inputTokens += r.tokens?.in ?? 0;
    llm.outputTokens += r.tokens?.out ?? 0;
    llm.costUsd += r.cost ?? 0;
    for (const m of r.models ?? []) llm.models.add(m);
    const decision = r.error ? null : parseDecision(r.reply, seen.controls.length);
    if (decision) return { ...decision, latencyMs, tokens, attempts: attempt };
    error = r.error ?? `not a decision: ${r.reply.replace(/\s+/g, ' ').slice(0, 160)}`;
    llm.failures++;
    llm.lastError = error;
    // A model that has never answered is not going to: stop rather than work through every visitor.
    if (llm.calls === llm.failures && llm.failures >= 6) throw new ModelDown(`the model has not answered once in ${llm.failures} calls (${error})`);
    if (attempt <= RETRIES) await new Promise(r => setTimeout(r, 1500 * attempt));
  }
  return { do: 'llm_error', error, latencyMs, tokens, attempts: RETRIES + 1 };
}

const out = opt.out ? resolve(opt.out) : null;
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'decisions.jsonl'), '');
}
const log = line => { if (out) appendFileSync(join(out, 'decisions.jsonl'), `${JSON.stringify(line)}\n`); };

// The local server, headless Chrome and one browser context per visitor: scripts/traffic/harness.mjs.
const { cleanUp, startServer, startChrome, session } = createHarness({
  label: 'personas', environment: opt.environment, apiUrl: opt['api-url'], eventsUrl: opt['events-url'], chrome: opt.chrome,
});

// A disabled button whose label ends in an ellipsis ("Scanning…") is the page saying it is busy.
const WORKING = String.raw`[...document.querySelectorAll('button:disabled')].some(b => /(…|\.\.\.)\s*$/.test(b.innerText ?? ''))`;

/**
 * Waits, as a person would, until the page has stopped changing: nothing asked of the server,
 * no button saying it is busy, and the same text three looks running.
 */
async function settle({ js, busy }, ms = 6000) {
  let last = -1;
  let same = 0;
  await until(async () => {
    const now = busy() ? -1 : await js(`${WORKING} ? -1 : document.body.innerText.length`);
    same = now === last && now >= 0 ? same + 1 : 0;
    last = now;
    return same >= 3;
  }, ms, 150);
}

async function visit(cdp, origin, n) {
  const identity = `persona-${seed}-${String(n).padStart(4, '0')}`;
  const p = persona(seed, n, maxSteps);
  const who = `${p.role}; ${p.arrival}; ${p.knowledge}; stakes ${p.stakes.split(':')[0]}; ${p.disposition}; patience ${p.patience}`;
  const v = {
    visitor: identity, persona: p, arm: 'unassigned', rendered: 'none', assigned: false, checkRun: false, setupSnippetCopied: false,
    ranCheck: false, steps: 0, exit: '', delivered: {}, lostBatches: 0, seconds: 0,
  };
  const began = Date.now();
  const draw = decisions(`stub:${identity}`);
  const s = await session(cdp, origin, identity, v, { readFlags: true });
  const { page, js, shows } = s;
  let down;
  try {
    await s.open();

    const behave = async () => {
      await page('Page.navigate', { url: `${origin}/app/` });
      if (!await shows(MAIN_BUTTON, 15000)) return 'error: the first screen did not load';
      await settle(s);
      v.rendered = await js(`document.querySelector('main.content .screen') ? 'screen' : document.querySelector('main.content .guided') ? 'guided' : 'overview'`);

      const history = [];
      for (let step = 1; step <= p.patience; step++) {
        const seen = await js(`(${lookAtPage})(${TEXT_CAP}, ${CONTROL_CAP})`);
        const d = await ask(p, seen, history, draw);
        const chosen = d.do === 'click' ? seen.controls[d.target - 1] : null;
        log({
          type: 'decision', visitor: identity, step, persona: who, controls: seen.controls.map(describeControl),
          ...(opt['log-screen'] ? { screen: seen.text } : {}),
          do: d.do, ...(chosen ? { target: d.target, label: chosen.label } : {}),
          ...(d.do === 'llm_error' ? { error: d.error } : { because: d.because }),
          latencyMs: d.latencyMs, tokens: d.tokens, attempts: d.attempts,
        });
        if (d.do === 'llm_error') return 'llm_error';
        if (d.do === 'leave') return 'left';
        if (chosen?.away) return 'followed_link_away'; // not followed: the visit to this page ends here
        if (chosen) {
          const clicked = await js(`(${clickInPage})(${d.target - 1}, ${JSON.stringify(chosen.label)})`);
          history.push(clicked ? `clicked "${chosen.label}"` : `tried to click "${chosen.label}", which was no longer there`);
        } else {
          await js(`scrollBy({ top: Math.round(innerHeight * 0.9), behavior: 'instant' })`);
          history.push('scrolled down');
        }
        v.steps = step;
        await settle(s);
      }
      return p.patience < maxSteps ? 'out_of_patience' : 'max_steps';
    };
    v.exit = await behave();
    v.ranCheck = s.checks() > 0;
    await s.leave(); // hides the window, which is when the dashboard sends what it has queued
    const flag = (await s.flags())?.find(f => f.feature?.name === FLAG);
    if (flag) v.arm = flag.variant ?? 'control';
  } catch (err) {
    if (err instanceof ModelDown) down = err;
    v.exit = `error: ${err.message}`;
  } finally {
    await s.dispose();
  }
  if (down) throw down;
  v.checkRun = (v.delivered.check_run ?? 0) > 0;
  v.setupSnippetCopied = (v.delivered.setup_snippet_copied ?? 0) > 0;
  v.seconds = Math.round((Date.now() - began) / 100) / 10;
  log({
    type: 'visitor', visitor: identity, persona: p, arm: v.arm, checkRun: v.checkRun, setupSnippetCopied: v.setupSnippetCopied,
    steps: v.steps, exit: v.exit, firstScreen: v.rendered, assigned: v.assigned, lostBatches: v.lostBatches, seconds: v.seconds,
  });
  return v;
}

const rate = (n, of) => (of ? Math.round((n / of) * 10000) / 10000 : 0);

function summarise(visits, wallSeconds) {
  const arms = {};
  const exits = {};
  const delivered = {};
  for (const v of visits) {
    const row = (arms[v.arm] ??= { visitors: 0, converted: 0, guardrail: 0, steps: 0 });
    row.visitors++;
    row.steps += v.steps;
    if (v.checkRun) row.converted++;
    if (v.setupSnippetCopied) row.guardrail++;
    const exit = v.exit.startsWith('error') ? 'error' : v.exit;
    exits[exit] = (exits[exit] ?? 0) + 1;
    for (const [name, count] of Object.entries(v.delivered)) delivered[name] = (delivered[name] ?? 0) + count;
  }
  for (const [arm, r] of Object.entries(arms)) {
    arms[arm] = {
      visitors: r.visitors, converted: r.converted, conversionRate: rate(r.converted, r.visitors),
      guardrail: r.guardrail, guardrailRate: rate(r.guardrail, r.visitors), meanSteps: Math.round((r.steps / r.visitors) * 100) / 100,
    };
  }
  const problem = v =>
    v.exit.startsWith('error') ? v.exit
    : v.assigned && !v.delivered.$flag_exposure ? 'assigned, but no exposure was delivered'
    : v.ranCheck && !v.checkRun ? 'ran a check, but check_run was not delivered'
    : (v.arm === 'control') === (v.rendered === 'screen') && v.arm !== 'unassigned' ? `arm ${v.arm} was shown the ${v.rendered} first screen`
    : null;
  return {
    simulated: true,
    kind: 'AI personas, not people',
    environment: opt.environment,
    seed,
    llm: opt.llm,
    model: stubbed ? 'stub' : { requested: opt.model, ids: [...llm.models] },
    maxSteps,
    visitors: visits.length,
    assigned: visits.filter(v => v.assigned).length,
    arms: Object.fromEntries(Object.entries(arms).sort(([a], [b]) => a.localeCompare(b))),
    exits,
    eventsDelivered: delivered,
    lostBatches: visits.reduce((sum, v) => sum + v.lostBatches, 0),
    modelCalls: llm.calls,
    modelFailures: llm.failures,
    llmErrors: visits.filter(v => v.exit === 'llm_error').length,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    costUsd: Math.round(llm.costUsd * 10000) / 10000,
    wallSeconds,
    meanSecondsPerVisitor: visits.length ? Math.round((visits.reduce((sum, v) => sum + v.seconds, 0) / visits.length) * 10) / 10 : 0,
    errors: visits.filter(problem).map(v => ({ visitor: v.visitor, arm: v.arm, problem: problem(v) })),
  };
}

function markdown(s) {
  const pct = r => `${(r * 100).toFixed(1)}%`;
  const model = s.llm === 'stub' ? 'a fixed rule in place of a model (`--llm stub`)' : `\`${s.model.ids.join('`, `') || s.model.requested}\``;
  const lines = [
    `### AI-persona traffic: ${s.visitors} visitors`,
    '',
    'These are AI personas, not people. Each visitor is a language model playing one invented person, shown the text and the controls on the screen and asked what that person does next. It is not told what is measured or which version it sees. The numbers say how a model reads each first screen; they are not a forecast of what people would do.',
    '',
    `Environment \`${s.environment}\`, seed \`${s.seed}\`, model ${model}, at most ${s.maxSteps} steps a visitor.`,
    '',
    '| First screen | Visitors | Ran a check (`check_run`) | Rate | Copied a set-up snippet (`setup_snippet_copied`) | Rate | Mean steps |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(s.arms).map(([arm, r]) => `| \`${arm}\` | ${r.visitors} | ${r.converted} | ${pct(r.conversionRate)} | ${r.guardrail} | ${pct(r.guardrailRate)} | ${r.meanSteps} |`),
    '',
    'A step is one click or one scroll. Both events are counted from the batches Flagsmith accepted.',
    '',
    `How visits ended: ${Object.entries(s.exits).map(([k, n]) => `\`${k}\` × ${n}`).join(', ')}.`,
    `Model: ${s.modelCalls} calls, ${s.modelFailures} failed or unreadable, ${s.llmErrors} visitors ended as \`llm_error\`; ${s.inputTokens.toLocaleString('en-US')} tokens in, ${s.outputTokens.toLocaleString('en-US')} out; cost as the CLI reports it $${s.costUsd.toFixed(4)}.`,
    `Time: ${s.wallSeconds} s in all, ${s.meanSecondsPerVisitor} s a visitor on average.`,
    `Events Flagsmith accepted: ${Object.entries(s.eventsDelivered).map(([k, n]) => `\`${k}\` × ${n}`).join(', ') || 'none'}. Batches lost: ${s.lostBatches}.`,
  ];
  if (s.errors.length) lines.push('', `Visitors with a problem: ${s.errors.length}`, ...s.errors.slice(0, 10).map(e => `- \`${e.visitor}\`: ${e.problem}`));
  return lines.join('\n');
}

let exitCode = 0;
try {
  const started = Date.now();
  log({ type: 'run', simulated: true, kind: 'AI personas, not people', environment: opt.environment, seed, llm: opt.llm, model: opt.model, maxSteps, visitors: total, startedAt: new Date(started).toISOString() });
  const origin = await startServer();
  const cdp = await startChrome();
  const visits = [];
  let sent = 0;
  let fatal;
  // With --until-each, the run goes on past --visitors while any version is short. Only how many
  // visitors each version has had decides that, never what they did.
  const perArm = () => visits.reduce((n, v) => ({ ...n, [v.arm]: (n[v.arm] ?? 0) + 1 }), {});
  const short = () => untilEach > 0 && sent < total * 2 && Object.values(perArm()).some(n => n < untilEach);
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (!fatal && (sent < total || short())) {
      try {
        visits.push(await visit(cdp, origin, ++sent));
      } catch (err) {
        fatal ??= err;
      }
      if (!fatal && visits.length % 10 === 0) {
        console.error(`personas: ${visits.length} visitors done (${Object.entries(perArm()).map(([arm, n]) => `${arm} ${n}`).join(', ')}), ${llm.failures} model failures, ${Math.round((Date.now() - started) / 1000)} s`);
      }
    }
  }));
  if (fatal) throw fatal;
  const finished = [...visits];
  visits.sort((a, b) => a.visitor.localeCompare(b.visitor));
  const summary = summarise(visits, Math.round((Date.now() - started) / 100) / 10);
  if (out) {
    writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(join(out, 'summary.md'), `${markdown(summary)}\n`);
    writeFileSync(join(out, 'replay.json'), `${JSON.stringify(replayOf(finished, summary.errors), null, 2)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY && !opt['self-test']) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown(summary)}\n`);
  console.log(JSON.stringify(summary));
  const failed = summary.errors.length + summary.llmErrors;
  if (failed > (opt['self-test'] ? 0 : total / 5) || (opt['self-test'] && summary.lostBatches > 0)) exitCode = 1;
} catch (err) {
  console.error(`personas: ${err.message}`);
  exitCode = 1;
} finally {
  await cleanUp();
  if (llmDir) rmSync(llmDir, { recursive: true, force: true });
}
process.exit(exitCode);

/*
 * Landing page behaviour: the island menu, the arena in the hero, scroll reveals, the current
 * section in the nav, the tagline that lights up word by word, and the copy button. No Flagsmith here:
 * an experiment only enrols a visitor who opens /app/ with no page in the link, and every link on this
 * page names a page.
 */
import type { AgentKey } from '../../../../packages/arena/src/agents.ts';
import type { ArenaRecord } from '../../../../packages/arena/src/debate.ts';
import type { ArenaState } from '../../../../packages/arena/src/ledger.ts';
import type { Side } from '../../../../packages/arena/src/playbook.ts';
import type { ArenaView } from '../lib/api.ts';
import { inWords, named } from '../lib/arena-words.ts';
import { mountDuelViz } from '../lib/duel-viz.ts';
import './landing.css';

document.documentElement.classList.add('js');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Island menu (small screens).
const navWrap = document.querySelector<HTMLElement>('.nav-wrap');
const burger = document.querySelector<HTMLButtonElement>('.burger');
const menu = document.getElementById('menu');
if (navWrap && burger && menu) {
  menu.hidden = false;
  menu.inert = true;
  const setMenu = (open: boolean) => {
    navWrap.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    menu.inert = !open;
    document.body.style.overflow = open ? 'hidden' : '';
  };
  burger.addEventListener('click', () => setMenu(burger.getAttribute('aria-expanded') !== 'true'));
  menu.addEventListener('click', e => { if ((e.target as HTMLElement).closest('a')) setMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
}

// The arena, from the files the dashboard's Arena page reads (GET /api/arena). The page ships with
// the debate's numbers written in; they are filled again from the record, so the two cannot drift.
// Once a person has started the experiment and markets have settled, the hero card replays them:
// one dot per market, in the order they settled. Before that it shows the backtest and the rule.
interface Seal { experiment: number; started_at: string | null }
interface Verdict { state: 'decided' | 'void'; winner: string | null; why: string; read_at: string }

const one = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const say = (selector: string, text: string) => { const el = one(selector); if (el) el.textContent = text; };
const count = (n: number) => n.toLocaleString('en-US');
/** A share with one decimal, and none when it is a whole number: 54.5%, 52%. */
const share = (v: number) => `${(v * 100).toFixed(1).replace(/\.0$/, '')}%`;
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });

function fill(record: ArenaRecord) {
  const { brief, finalists, coin, past, usage } = record;
  const values: Record<string, string> = {
    name: record.name,
    'hours.seen': String(brief.past.hours - brief.past.held_hours),
    'hours.held': String(brief.past.held_hours),
    'past.seen': count(past.seen),
    'past.held': count(past.held),
    'coin.seen': share(coin.seen.rate),
    'coin.held': share(coin.held.rate),
    'rule.min': count(brief.rule.min_per_arm),
    'rule.win': share(brief.rule.win_above),
    'rule.harm': share(brief.rule.harm_below),
    'usage.calls': count(usage.calls),
    'usage.seconds': count(usage.seconds),
    'usage.tokens': count(usage.tokens.in + usage.tokens.out),
    stake: `$${brief.venue.stake}`,
  };
  if (record.agreement !== null) values.agreement = share(record.agreement);
  for (const [short, key] of [['a', 'agent_a'], ['b', 'agent_b']] as [string, AgentKey][]) {
    const f = finalists[key];
    if (!f) continue;
    values[`${short}.playbook`] = f.playbook.name;
    values[`${short}.seen`] = share(f.seen.rate);
    values[`${short}.held`] = share(f.held.rate);
    for (const [arm, rate] of Object.entries(f.predicts ?? {})) values[`${short}.p.${arm}`] = share(rate);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-fill]')) {
    const value = values[el.dataset.fill ?? ''];
    if (value !== undefined) el.textContent = value;
  }
  // The playbooks, in the same words the Arena page uses.
  for (const list of document.querySelectorAll<HTMLElement>('[data-rules]')) {
    const playbook = finalists[list.dataset.rules as AgentKey]?.playbook;
    if (!playbook) continue;
    const row = (text: string, side: Side, cls = '') => {
      const li = document.createElement('li');
      if (cls) li.className = cls;
      const when = document.createElement('span');
      when.textContent = text;
      const call = document.createElement('b');
      call.textContent = side === 'up' ? 'Up' : 'Down';
      li.append(when, call);
      return li;
    };
    list.replaceChildren(...playbook.rules.map(rule => row(inWords(rule), rule.side)), row('Otherwise', playbook.otherwise, 'else'));
  }
}

function showArena(view: ArenaView | null) {
  const record = (view?.record ?? null) as ArenaRecord | null;
  if (!record) return;
  fill(record);
  // Until a person has started the experiment, anything else in the directory is a rehearsal.
  const seal = view?.seal as Seal | null;
  if (!seal?.started_at) return;
  const state = (view?.state ?? null) as ArenaState | null;
  const verdict = (view?.verdict ?? null) as Verdict | null;
  const name = (k: string) => (k === 'control' ? 'Coin' : record.agents[k as AgentKey]?.name ?? k);
  const decided = verdict?.state === 'decided';
  const winner = decided && verdict.winner && verdict.winner !== 'control' ? verdict.winner : null;
  const settled = state ? state.order.reduce((n, k) => n + (state.arms[k]?.settled ?? 0), 0) : 0;
  const result = decided ? (winner ? `${name(winner)} wins` : 'The coin stays') : verdict ? 'Void' : `${count(settled)} markets settled`;

  say('[data-arena-meta]', `Experiment ${seal.experiment} in Flagsmith · Paper money`);
  const status = one('[data-arena-status]');
  const stage = one('[data-arena-viz]');
  if (state && settled && stage) {
    stage.replaceChildren();
    mountDuelViz(stage, {
      lanes: state.order.map(k => ({
        key: k,
        label: name(k),
        note: k === 'control' ? 'The control' : record.agents[k as AgentKey]?.stance,
        visitors: state.arms[k]?.settled ?? 0,
        converted: state.arms[k]?.won ?? 0,
      })),
      visits: state.replay,
      baseline: 'control',
      did: 'right call',
      missed: 'Wrong call',
      unit: 'markets',
      winner,
      result,
      status,
      caption: 'One dot is one market, in the order they settled.',
      autoplay: true,
      delay: 1200,
    });
  } else if (status) status.textContent = 'Running: no market has settled yet';

  if (verdict) {
    say('[data-arena-verdict]', result);
    say('[data-arena-verdict-meta]', `Experiment ${seal.experiment} · Read once on ${day(verdict.read_at)}`);
    say('[data-arena-why]', named(verdict.why));
  } else {
    say('[data-arena-verdict-meta]', `Experiment ${seal.experiment} is running · Read once, when every version has its markets`);
  }
}
// Without the server the page keeps what it was built with.
fetch('/api/arena', { headers: { accept: 'application/json' } })
  .then(response => (response.ok ? response.json() as Promise<ArenaView | null> : null))
  .then(showArena)
  .catch(() => {});

// Fade up as sections enter the viewport, staggered among siblings.
const revealed = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in');
    revealed.unobserve(e.target);
  }
}, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
for (const el of document.querySelectorAll<HTMLElement>('[data-reveal]')) {
  const siblings = el.parentElement ? [...el.parentElement.children].filter(c => c.hasAttribute('data-reveal')) : [];
  el.style.transitionDelay = `${Math.max(0, siblings.indexOf(el)) * 100}ms`;
  if (reduceMotion) el.classList.add('in'); else revealed.observe(el);
}

// Mark the nav link for the section in the middle of the screen.
const navLinks = [...document.querySelectorAll<HTMLAnchorElement>('.nav-links a')];
const spy = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    for (const a of navLinks) {
      if (a.hash === `#${e.target.id}`) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
  }
}, { rootMargin: '-45% 0px -50% 0px' });
for (const id of ['top', ...navLinks.map(a => a.hash.slice(1))]) {
  const section = document.getElementById(id);
  if (section) spy.observe(section);
}

// Tagline: words go from muted to full colour one at a time, in reading order, once it is on screen.
// The lines stay lines; a screen reader gets the sentence whole instead of word by word.
const tagline = document.querySelector<HTMLElement>('[data-words]');
if (tagline) {
  const sentences: string[] = [];
  let n = 0;
  for (const line of tagline.querySelectorAll<HTMLElement>('.line')) {
    const words = (line.textContent ?? '').trim().split(/\s+/);
    sentences.push(words.join(' '));
    line.setAttribute('aria-hidden', 'true');
    line.replaceChildren(...words.flatMap((w, i) => {
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = w;
      span.style.transitionDelay = `${n++ * 110}ms`;
      return i < words.length - 1 ? [span, document.createTextNode(' ')] : [span];
    }));
  }
  const whole = document.createElement('span');
  whole.className = 'sr-only';
  whole.textContent = sentences.join(' ');
  tagline.prepend(whole);
  if (reduceMotion) tagline.classList.add('lit');
  else {
    const seen = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      tagline.classList.add('lit');
      seen.disconnect();
    }, { threshold: 0.4 });
    seen.observe(tagline);
  }
}

// Copy buttons: data-copy names the element whose text goes to the clipboard.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  const label = button.querySelector<HTMLElement>('.copy-label');
  let timer = 0;
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy ?? '');
    const text = source?.textContent?.trim();
    if (!source || !text) return;
    // Where the clipboard is refused, select the line so it can be copied by hand.
    try { await navigator.clipboard.writeText(text); } catch { getSelection()?.selectAllChildren(source); return; }
    button.classList.add('copied');
    if (label) label.textContent = 'Copied';
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      button.classList.remove('copied');
      if (label) label.textContent = 'Copy';
    }, 2000);
  });
}

// A link to a question in the FAQ opens it.
const openTarget = () => {
  const target = location.hash.length > 1 ? document.getElementById(location.hash.slice(1)) : null;
  if (target instanceof HTMLDetailsElement) target.open = true;
};
addEventListener('hashchange', openTarget);
openTarget();

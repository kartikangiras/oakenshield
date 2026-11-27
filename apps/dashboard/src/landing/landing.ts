/*
 * Landing page behaviour: the island menu, scroll reveals, the current section in the nav, the tagline
 * that lights up word by word, and the copy button. No Flagsmith here: an experiment only enrols a
 * visitor who opens /app/ with no page in the link, and every link on this page names a page.
 */
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

// Tagline: words go from muted to full colour one at a time, in reading order, as it scrolls through.
// The lines stay lines; a screen reader gets the sentence whole instead of word by word.
const tagline = document.querySelector<HTMLElement>('[data-words]');
if (tagline) {
  const spans: HTMLSpanElement[] = [];
  const sentences: string[] = [];
  for (const line of tagline.querySelectorAll<HTMLElement>('.line')) {
    const words = (line.textContent ?? '').trim().split(/\s+/);
    sentences.push(words.join(' '));
    line.setAttribute('aria-hidden', 'true');
    line.replaceChildren(...words.flatMap((w, i) => {
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = w;
      spans.push(span);
      return i < words.length - 1 ? [span, document.createTextNode(' ')] : [span];
    }));
  }
  const whole = document.createElement('span');
  whole.className = 'sr-only';
  whole.textContent = sentences.join(' ');
  tagline.prepend(whole);
  let lit = -1;
  const paint = () => {
    const box = tagline.getBoundingClientRect();
    // 0 when the tagline's top reaches 90% of the viewport, 1 when its bottom reaches 25%.
    const start = innerHeight * 0.9, end = innerHeight * 0.25;
    const progress = Math.min(1, Math.max(0, (start - box.top) / (start - end + box.height)));
    const next = Math.round(progress * spans.length) - 1;
    if (next === lit) return;
    spans.forEach((s, i) => s.classList.toggle('on', i <= next));
    lit = next;
  };
  if (reduceMotion) spans.forEach(s => s.classList.add('on'));
  else {
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; paint(); });
    };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll, { passive: true });
    paint();
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

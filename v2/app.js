// AWDPI v2 prototype — shared behaviour. No tracking, nothing leaves the browser.
const STILL = /[?&]still\b/.test(location.search); // screenshot mode: no scroll animations
if (!STILL) document.documentElement.classList.add('js');

// Quick exit: the button, or Esc pressed twice within a second, replaces this page with Google.
(() => {
  const leave = () => { try { document.body.style.visibility = 'hidden'; } catch (e) {} location.replace('https://www.google.com/'); };
  document.querySelectorAll('[data-quick-exit]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); leave(); }));
  let last = 0;
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const now = Date.now();
    if (now - last < 1000) leave();
    last = now;
  });
})();

// Sticky header gets a soft shadow once the page has scrolled.
(() => {
  const head = document.querySelector('.site');
  if (!head) return;
  const set = () => head.classList.toggle('is-stuck', scrollY > 8);
  addEventListener('scroll', set, { passive: true }); set();
})();
// Height of the header part that stays on screen (on a phone the logo row scrolls away).
const headStuck = () => { const h = document.querySelector('.site'); return h ? h.offsetHeight + (parseFloat(getComputedStyle(h).top) || 0) : 0; };

// Page opening. Home: the line under the headline cycles through the key facts, letter by letter, every few seconds;
// the values band runs by itself (CSS). Both stop while the hero is off screen or the tab is hidden, and the pause button stops them.
// Inner pages: the picture leans slightly away from the mouse.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const art = document.querySelector('[data-art]');
  if (art) {
    const items = [...art.querySelectorAll('.rot__item')];
    const tog = art.querySelector('[data-art-toggle]');
    let cur = 0, onScreen = true;
    tog.addEventListener('click', () => {
      const p = art.classList.toggle('is-paused');
      tog.setAttribute('aria-pressed', String(p));
      tog.setAttribute('aria-label', p ? tog.dataset.labelPlay : tog.dataset.labelPause);
    });
    // the values band moves at the same reading speed (about 36px a second) whatever its length or language
    const track = art.querySelector('[data-ticker]');
    const pace = () => { if (track) track.style.setProperty('--dur', (track.scrollWidth / 2 / 36).toFixed(1) + 's'); };
    pace(); if (document.fonts) document.fonts.ready.then(pace);
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; art.classList.toggle('is-held', !onScreen); }).observe(art);
    if (!STILL && !reduce && items.length > 1) {
      setInterval(() => {
        if (!onScreen || document.hidden || art.classList.contains('is-paused')) return;
        const out = items[cur]; cur = (cur + 1) % items.length;
        out.classList.replace('is-on', 'is-off');
        setTimeout(() => out.classList.remove('is-off'), 1000);
        items[cur].classList.add('is-on');
      }, 3400);
    }
  }
  if (STILL || reduce || !matchMedia('(pointer: fine)').matches) return;
  // program cards: a soft light follows the pointer across the card
  document.querySelectorAll('[data-spot]').forEach(card => card.addEventListener('pointermove', e => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--sx', (e.clientX - r.left).toFixed(0) + 'px');
    card.style.setProperty('--sy', (e.clientY - r.top).toFixed(0) + 'px');
  }));
  document.querySelectorAll('[data-parallax]').forEach(sec => {
    sec.addEventListener('pointermove', e => {
      const r = sec.getBoundingClientRect();
      sec.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 2 - 1).toFixed(3));
      sec.style.setProperty('--my', ((e.clientY - r.top) / r.height * 2 - 1).toFixed(3));
    });
    sec.addEventListener('pointerleave', () => { sec.style.setProperty('--mx', 0); sec.style.setProperty('--my', 0); });
  });
})();

// Reveal, bar charts and number count-up when a block scrolls into view.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const count = el => {
    const raw = el.dataset.count; const end = parseFloat(raw.replace(/,/g, ''));
    const fmt = n => (raw.includes(',') ? Math.round(n).toLocaleString('en-US') : String(Math.round(n)));
    if (reduce || !isFinite(end)) return;
    const t0 = performance.now(); const dur = 1200;
    const tick = t => { const p = Math.min(1, (t - t0) / dur); el.firstChild.nodeValue = fmt(end * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(tick); };
    el.firstChild.nodeValue = fmt(0); requestAnimationFrame(tick);
  };
  const els = document.querySelectorAll('[data-reveal], [data-chart]');
  if (STILL) { els.forEach(el => el.classList.add('is-in')); return; }
  if (!('IntersectionObserver' in window)) { els.forEach(el => el.classList.add('is-in')); return; }
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (!e.isIntersecting) return;
    e.target.classList.add('is-in');
    e.target.querySelectorAll('[data-count]').forEach(count);
    io.unobserve(e.target);
  }), { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  els.forEach(el => io.observe(el));
})();

// Filter chips (research table, stories grid).
(() => {
  document.querySelectorAll('[data-filters]').forEach(bar => {
    const list = document.getElementById(bar.dataset.filters);
    if (!list) return;
    const items = [...list.querySelectorAll('[data-tags]')];
    bar.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      bar.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      const f = b.dataset.filter;
      items.forEach(it => { it.hidden = f !== 'all' && !it.dataset.tags.split(' ').includes(f); });
      const live = document.getElementById(bar.dataset.filters + '-count');
      if (live) { const n = items.filter(i => !i.hidden).length; live.textContent = document.documentElement.lang.startsWith('zh') ? `显示 ${n} 项` : n + ' shown'; }
    });
  });
})();

// Find help by country: a tile per country. The time-zone guess runs only in this browser; nothing is sent.
(() => {
  const box = document.querySelector('[data-finder]'); if (!box) return;
  const tiles = [...box.querySelectorAll('[data-help-k]')], panels = [...box.querySelectorAll('[data-help]')];
  const show = v => {
    panels.forEach(p => { p.hidden = p.dataset.help !== v; });
    tiles.forEach(t => t.setAttribute('aria-pressed', String(t.dataset.helpK === v)));
  };
  const out = box.querySelector('.finder2__out'), narrow = matchMedia('(max-width: 1023px)');
  tiles.forEach(t => t.addEventListener('click', () => {
    show(t.dataset.helpK);
    // On a phone the numbers sit below the tiles: bring them into view.
    if (out && narrow.matches && out.getBoundingClientRect().top > innerHeight * 0.55) {
      out.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
  }));
  const zones = { 'Europe/Brussels': 'be', 'Europe/London': 'uk', 'Europe/Paris': 'fr', 'Europe/Berlin': 'de', 'Europe/Amsterdam': 'nl' };
  let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  const guess = zones[tz] || (tz.startsWith('Australia/') ? 'au' : /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit)|^Pacific\/Honolulu/.test(tz) ? 'us' : '');
  if (guess) show(guess);
})();

// The prototype form does not send anything.
(() => {
  const f = document.querySelector('[data-proto-form]'); if (!f) return;
  f.addEventListener('submit', e => { e.preventDefault(); const n = f.querySelector('[data-form-note]'); if (n) n.hidden = false; });
})();

// Map: pointing at an office lights up its pin (and the reverse). While on screen and untouched, it walks through the offices.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-map]').forEach(map => {
    const rows = [...map.querySelectorAll('[data-office]')], pins = [...map.querySelectorAll('[data-pin]')];
    let auto = null, n = 0, touched = false;
    const set = key => {
      map.classList.toggle('has-active', !!key);
      rows.forEach(r => { const on = r.dataset.office === key; r.classList.toggle('is-active', on); r.setAttribute('aria-pressed', String(on)); });
      pins.forEach(p => p.classList.toggle('is-active', p.dataset.pin === key));
    };
    const stop = () => { clearInterval(auto); auto = null; };
    const pick = key => { touched = true; stop(); set(key); };
    [...rows, ...pins].forEach(el => {
      const key = el.dataset.office || el.dataset.pin;
      ['mouseenter', 'focus', 'click'].forEach(ev => el.addEventListener(ev, () => pick(key)));
    });
    map.addEventListener('mouseleave', () => { if (touched) set(null); });
    if (STILL || reduce || !('IntersectionObserver' in window)) return;
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !auto && !touched) auto = setInterval(() => { if (!document.hidden) set(rows[n++ % rows.length].dataset.office); }, 2200);
      else if (!e.isIntersecting) { stop(); if (!touched) set(null); }
    }, { threshold: .4 }).observe(map);
  });
})();

// History timeline: click a year or use the arrows. It plays through on its own while on screen; the pause button stops it.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-tline]').forEach(tl => {
    const steps = [...tl.querySelectorAll('[data-step]')], panels = [...tl.querySelectorAll('.tpanel')];
    const play = tl.querySelector('[data-play]');
    let cur = 0, timer = null, onScreen = false;
    const show = (i, focus) => {
      cur = (i + steps.length) % steps.length;
      steps.forEach((s, k) => { s.setAttribute('aria-selected', String(k === cur)); s.tabIndex = k === cur ? 0 : -1; });
      panels.forEach((p, k) => { p.hidden = k !== cur; });
      tl.style.setProperty('--p', cur / (steps.length - 1));
      if (focus) steps[cur].focus();
    };
    const setPlay = on => {
      clearInterval(timer); timer = on ? setInterval(() => { if (onScreen && !document.hidden) show(cur + 1); }, 5500) : null;
      tl.classList.toggle('is-playing', !!on);
      if (play) { play.setAttribute('aria-pressed', String(!!on)); play.setAttribute('aria-label', on ? play.dataset.labelPause : play.dataset.labelPlay); }
    };
    const user = i => { setPlay(false); show(i); };
    steps.forEach((s, k) => {
      s.addEventListener('click', () => user(k));
      s.addEventListener('keydown', e => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { e.preventDefault(); setPlay(false); show(cur + d, true); }
      });
    });
    const prev = tl.querySelector('[data-prev]'), next = tl.querySelector('[data-next]');
    if (prev) prev.addEventListener('click', () => user(cur - 1));
    if (next) next.addEventListener('click', () => user(cur + 1));
    if (play) play.addEventListener('click', () => setPlay(!timer));
    show(0);
    if (STILL || reduce) return;
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }, { threshold: .35 }).observe(tl);
    else onScreen = true;
    setPlay(true);
  });
})();

// Focus areas: one tab per program. Without this script the four programs simply show one after another.
(() => {
  document.querySelectorAll('[data-tabs]').forEach(box => {
    const tabs = [...box.querySelectorAll('[data-tab]')], panels = [...box.querySelectorAll('[data-panel]')];
    if (!tabs.length) return;
    const show = (key, focus) => {
      tabs.forEach(t => { const on = t.dataset.tab === key; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
      panels.forEach(p => p.classList.toggle('is-on', p.dataset.panel === key));
    };
    box.classList.add('px--tabs');
    const fromHash = tabs.find(t => '#' + t.dataset.tab === location.hash);
    show((fromHash || tabs[0]).dataset.tab);
    // opened from a link such as focus-areas.html#spaces: after the browser's own jump, show the tabs and the program together
    if (fromHash) addEventListener('load', () => setTimeout(() => scrollTo({ top: box.getBoundingClientRect().top + scrollY - headStuck() - 8 }), 0));
    const toTop = () => { const top = box.getBoundingClientRect().top + scrollY - headStuck() - 12; if (scrollY > top + 40) scrollTo({ top, behavior: 'smooth' }); };
    document.querySelectorAll('[data-tab-link]').forEach(a => a.addEventListener('click', e => {
      const key = a.dataset.tabLink;
      if (!tabs.some(t => t.dataset.tab === key)) return;
      e.preventDefault(); show(key); history.replaceState(null, '', '#' + key);
      const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
      scrollTo({ top: box.getBoundingClientRect().top + scrollY - headStuck() - 8, behavior: calm ? 'auto' : 'smooth' });
    }));
    tabs.forEach((t, i) => {
      t.addEventListener('click', e => { e.preventDefault(); show(t.dataset.tab); history.replaceState(null, '', '#' + t.dataset.tab); toTop(); });
      t.addEventListener('keydown', e => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault(); const nx = tabs[(i + d + tabs.length) % tabs.length]; show(nx.dataset.tab, true);
      });
    });
  });
})();

// About: organisation structure. Pick a department (click, or arrow keys) to see its teams.
// Without this script every department's teams simply show one after another.
(() => {
  const box = document.querySelector('[data-org]');
  if (!box) return;
  const list = box.querySelector('[role="tablist"]');
  const tabs = [...box.querySelectorAll('[data-dept]')];
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const show = (t, focus) => {
    tabs.forEach(x => {
      const on = x === t;
      x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1;
      document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) t.focus({ preventScroll: true });
    // tablet and phone: the list scrolls sideways, so bring the picked one into view
    if (list.scrollWidth > list.clientWidth + 2) list.scrollTo({ left: t.offsetLeft - 12, behavior: calm ? 'auto' : 'smooth' });
  };
  show(tabs[0]);
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => show(t));
    t.addEventListener('keydown', ev => {
      const k = ev.key, n = tabs.length;
      const j = k === 'ArrowDown' || k === 'ArrowRight' ? (i + 1) % n : k === 'ArrowUp' || k === 'ArrowLeft' ? (i - 1 + n) % n : k === 'Home' ? 0 : k === 'End' ? n - 1 : -1;
      if (j < 0) return;
      ev.preventDefault(); show(tabs[j], true);
    });
  });
})();

// Avoice: six kinds of support. Point at one (or click, or use the arrow keys) to see it large.
// Without this script the first kind shows.
(() => {
  document.querySelectorAll('[data-switch]').forEach(box => {
    const tabs = [...box.querySelectorAll('[data-sw]')];
    const show = (t, focus) => {
      tabs.forEach(x => {
        const on = x === t;
        x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1;
        document.getElementById(x.getAttribute('aria-controls')).classList.toggle('is-on', on);
      });
      if (focus) t.focus();
    };
    const fine = matchMedia('(hover: hover) and (pointer: fine)');
    let timer;
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => show(t));
      t.addEventListener('pointerenter', () => { if (!fine.matches) return; clearTimeout(timer); timer = setTimeout(() => show(t), 120); });
      t.addEventListener('pointerleave', () => clearTimeout(timer));
      t.addEventListener('keydown', ev => {
        const k = ev.key, n = tabs.length;
        const j = k === 'ArrowDown' || k === 'ArrowRight' ? (i + 1) % n : k === 'ArrowUp' || k === 'ArrowLeft' ? (i - 1 + n) % n : k === 'Home' ? 0 : k === 'End' ? n - 1 : -1;
        if (j < 0) return;
        ev.preventDefault(); show(tabs[j], true);
      });
    });
  });
})();

// Stories opening: the two columns of pictures drift slowly. One button pauses them;
// they also hold while the pointer is on them and while the opening is off screen.
(() => {
  document.querySelectorAll('[data-pausable]').forEach(box => {
    const btn = box.querySelector('[data-pause]');
    if (btn) btn.addEventListener('click', () => {
      const paused = box.classList.toggle('is-paused');
      btn.setAttribute('aria-pressed', String(paused));
      btn.setAttribute('aria-label', paused ? btn.dataset.labelPlay : btn.dataset.labelPause);
    });
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => box.classList.toggle('is-held', !e.isIntersecting)).observe(box);
  });
})();

// About opening: the end of the sentence types itself, one word after another (society, work, culture, education).
// The full list shows first; it holds while off screen. Screen readers get the full list once (a hidden copy).
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-typer]').forEach(el => {
    const words = el.dataset.typer.split('|'), w = el.querySelector('.typer__w');
    if (STILL || reduce || words.length < 2 || !w) return;
    let onScreen = true;
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(el);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const tick = async ms => { await sleep(ms); while (!onScreen || document.hidden) await sleep(400); };
    (async () => {
      await sleep(3200);
      el.classList.add('is-typing');
      for (let i = 0; ; i++) {
        let t = w.textContent;
        while (t.length) { t = t.slice(0, -1); w.textContent = t; await tick(t.length > 12 ? 14 : 34); }
        await tick(220);
        const word = words[i % words.length];
        for (let k = 1; k <= word.length; k++) { w.textContent = word.slice(0, k); await tick(80); }
        await tick(2300);
      }
    })();
  });
})();

// Focus areas opening: the sentence finishes itself with each program in turn, and the arched picture changes with it.
// Each bar fills while its line shows; when it is full the next one starts. A bar can also be picked.
// The bars stop filling while the opening is off screen, and nothing turns by itself with reduced motion.
(() => {
  document.querySelectorAll('[data-cycle]').forEach(box => {
    const items = [...box.querySelectorAll('.say__box .rot__item')], imgs = [...box.querySelectorAll('.ph-fx__art img')], bars = [...box.querySelectorAll('[data-cyc]')];
    if (items.length < 2) return;
    const colours = items.map(it => [...it.classList].find(c => c.startsWith('c-')));
    let cur = 0;
    const go = n => {
      if (n !== cur) {
        const out = items[cur];
        out.classList.remove('is-on'); out.classList.add('is-off');
        setTimeout(() => out.classList.remove('is-off'), 900);
        items[n].classList.add('is-on');
        imgs.forEach((im, k) => im.classList.toggle('is-on', k === n));
        box.classList.remove(colours[cur]); box.classList.add(colours[n]);
      }
      cur = n;
      bars.forEach(b => b.setAttribute('aria-pressed', 'false'));
      void box.offsetWidth;  // restart the bar's fill
      bars[cur].setAttribute('aria-pressed', 'true');
    };
    bars.forEach((b, k) => {
      b.addEventListener('click', () => go(k));
      b.addEventListener('animationend', () => { if (k === cur) go((cur + 1) % items.length); });
    });
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => box.classList.toggle('is-held', !e.isIntersecting)).observe(box);
  });
})();

// Research opening: the line flips through the places the reports cover, about every three seconds, and that
// report's cover steps forward in the fan. Pointing at a cover picks it (and holds the turning while the pointer
// stays on the covers). Nothing turns by itself off screen or with reduced motion.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-flip]').forEach(box => {
    const items = [...box.querySelectorAll('.flip__box .rot__item')], covers = [...box.querySelectorAll('.cover')], fan = box.querySelector('.covers');
    if (items.length < 2) return;
    let cur = 0, onScreen = true, over = false;
    const go = n => {
      if (n === cur) return;
      const out = items[cur];
      out.classList.remove('is-on'); out.classList.add('is-off');
      setTimeout(() => out.classList.remove('is-off'), 800);
      items[n].classList.add('is-on');
      covers.forEach((c, k) => c.classList.toggle('is-front', k === n));
      cur = n;
    };
    covers.forEach((c, k) => c.addEventListener('pointerenter', () => go(k)));
    if (fan) { fan.addEventListener('pointerenter', () => { over = true; }); fan.addEventListener('pointerleave', () => { over = false; }); }
    if (STILL || reduce) return;
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(box);
    setTimeout(function turn() {
      if (onScreen && !over && !document.hidden) go((cur + 1) % items.length);
      setTimeout(turn, 3000);
    }, 3400);
  });
})();

// Stories opening: a highlighter hops from one kind of story to the next. Pointing at one holds it there.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-hop]').forEach(p => {
    const ks = [...p.querySelectorAll('.hop__k')];
    if (ks.length < 2 || STILL || reduce) return;
    let cur = 0, onScreen = true, held = false;
    const go = n => { ks.forEach((k, j) => k.classList.toggle('is-on', j === n)); cur = n; };
    ks.forEach((k, j) => {
      k.addEventListener('pointerenter', () => { held = true; go(j); });
      k.addEventListener('pointerleave', () => { held = false; });
    });
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(p);
    setTimeout(function hop() {
      if (onScreen && !held && !document.hidden) go((cur + 1) % ks.length);
      setTimeout(hop, 1900);
    }, 2600);
  });
})();

// About, why overseas Asian women: each time the block comes into view, the Asian circle shows its sentence, then
// the Women circle, then the two slide together and the overlap, her, carries both. Off screen it resets, so it
// plays again on the way back. A click on any label brings the circles together and shows that part; pointing only
// works once they have met, so a cursor resting where the page scrolls past can't stop the story halfway.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-dw]').forEach(box => {
    const btns = [...box.querySelectorAll('[data-dw-k]')], panes = [...box.querySelectorAll('[data-dw-p]')];
    const vis = box.querySelector('.dw__v');
    let timers = [], armed = true;
    const set = k => {
      box.dataset.state = k;
      btns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.dwK === k)));
      panes.forEach(p => p.classList.toggle('is-on', p.dataset.dwP === k));
    };
    const stop = () => { timers.forEach(clearTimeout); timers = []; };
    const settled = () => !timers.length && !box.classList.contains('is-apart');
    const join = () => box.classList.remove('is-apart');
    btns.forEach(b => {
      b.addEventListener('click', () => { stop(); armed = false; join(); set(b.dataset.dwK); });
      b.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse' && settled()) set(b.dataset.dwK); });
    });
    if (vis) vis.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && settled()) set('both'); });
    if (STILL || reduce || !('IntersectionObserver' in window)) return;
    const apart = () => { stop(); box.classList.add('is-apart'); set('a'); };
    apart();
    // starts once the block reaches the middle of the screen
    new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || !armed) return;
      armed = false; apart();
      timers = [
        setTimeout(() => set('b'), 2200),
        setTimeout(() => { timers = []; join(); set('both'); }, 4400),
      ];
    }, { rootMargin: '-30% 0px -30% 0px' }).observe(box);
    // fully off screen: set the circles apart again for the next visit
    new IntersectionObserver(([e]) => { if (!e.isIntersecting) { armed = true; apart(); } }).observe(box);
  });
})();

// The road from violence to help: a marker runs along it once, stopping at each hurdle. Afterwards pointing at a
// hurdle moves the marker there; leaving the road sends it on to help. With reduced motion the road stands lit.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-road]').forEach(road => {
    const stops = [...road.querySelectorAll('.road__s')], last = stops.length - 1;
    if (STILL || reduce || !('IntersectionObserver' in window) || last < 1) return;
    const at = n => stops.forEach((s, k) => { s.classList.toggle('is-past', k < n); s.classList.toggle('is-at', k === n); });
    road.classList.add('is-live'); at(-1);
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      let n = 0;
      at(0);
      const step = setInterval(() => {
        n += 1; at(n);
        if (n >= last) {
          clearInterval(step);
          road.classList.add('is-ran');
          stops.forEach((s, k) => s.addEventListener('pointerenter', () => at(k)));
          road.addEventListener('pointerleave', () => at(last));
        }
      }, 1100);
    }, { threshold: 0.5 });
    io.observe(road);
  });
})();

// About, five years in numbers: one panel is open at a time. Pointing at (or clicking, or tabbing to) another
// opens it, and its figures count up. The open panel's figures also count up the first time it scrolls in.
(() => {
  const calm = STILL || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const count = el => {
    const raw = el.dataset.n, end = parseFloat(raw.replace(/,/g, ''));
    if (calm || !isFinite(end)) return;
    const fmt = n => (raw.includes(',') ? Math.round(n).toLocaleString('en-US') : String(Math.round(n)));
    const t0 = performance.now(), dur = 900;
    const tick = t => { const k = Math.min(1, (t - t0) / dur); el.textContent = fmt(end * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(tick); };
    el.textContent = fmt(0); requestAnimationFrame(tick);
  };
  document.querySelectorAll('[data-five]').forEach(box => {
    const ps = [...box.querySelectorAll('.five__p')];
    let wait;
    const open = p => {
      if (p.classList.contains('is-open')) return;
      ps.forEach(q => { const on = q === p; q.classList.toggle('is-open', on); q.querySelector('.five__h').setAttribute('aria-expanded', String(on)); });
      p.querySelectorAll('.five__list [data-n]').forEach(count);
    };
    ps.forEach(p => {
      p.addEventListener('click', () => open(p));
      p.querySelector('.five__h').addEventListener('focus', () => open(p));
      if (fine) {
        p.addEventListener('pointerenter', () => { clearTimeout(wait); wait = setTimeout(() => open(p), 140); });
        p.addEventListener('pointerleave', () => clearTimeout(wait));
      }
    });
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      box.querySelectorAll('[data-n]').forEach(count);
    }, { threshold: 0.3 });
    io.observe(box);
  });
})();

// Avoice, why they rarely get help: a deck of five cards. The front card turns when the bar under its title is
// full; clicking the deck shows the next card, and a title brings its own card forward. The bar holds while the
// deck is off screen or under the pointer, and nothing turns by itself with reduced motion.
(() => {
  document.querySelectorAll('[data-deck]').forEach(box => {
    const cards = [...box.querySelectorAll('.deck__card')], btns = [...box.querySelectorAll('[data-deck-k]')], stack = box.querySelector('.deck__stack');
    const n = cards.length; if (n < 2) return;
    let cur = 0;
    const place = skip => cards.forEach((c, j) => {
      if (c === skip) return;
      c.style.setProperty('--d', (j - cur + n) % n);
      c.classList.toggle('is-front', j === cur);
    });
    const go = k => {
      if (k === cur) return;
      const out = cards[cur];
      out.classList.remove('is-front'); out.classList.add('is-out');
      cur = k; place(out);
      setTimeout(() => { out.classList.remove('is-out'); place(); }, 420);
      btns.forEach(b => b.setAttribute('aria-pressed', 'false'));
      void box.offsetWidth;  // restart the bar
      btns[cur].setAttribute('aria-pressed', 'true');
    };
    place();
    btns.forEach((b, k) => {
      b.addEventListener('click', () => go(k));
      b.addEventListener('animationend', () => { if (k === cur) go((cur + 1) % n); });
    });
    if (stack) stack.addEventListener('click', () => go((cur + 1) % n));
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => box.classList.toggle('is-held', !e.isIntersecting)).observe(box);
  });
})();

// Get help, what we can help with: tabs ('I need ...'). Pointing at a tab opens it on a mouse; arrow keys move.
(() => {
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  document.querySelectorAll('[data-need]').forEach(box => {
    const tabs = [...box.querySelectorAll('[role="tab"]')], panels = [...box.querySelectorAll('[role="tabpanel"]')];
    let cur = -1;
    const go = (k, focus) => {
      if (k !== cur) {
        tabs.forEach((t, j) => { const on = j === k; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
        panels.forEach((p, j) => p.classList.toggle('is-on', j === k));
        box.style.setProperty('--k', k);
        box.style.setProperty('--ink-c', getComputedStyle(tabs[k]).getPropertyValue('--c'));
        cur = k;
      }
      if (focus) tabs[k].focus();
    };
    tabs.forEach((t, k) => {
      t.addEventListener('click', () => go(k));
      if (fine) t.addEventListener('pointerenter', () => go(k));
      t.addEventListener('keydown', e => {
        const m = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (m) { e.preventDefault(); go((k + m + tabs.length) % tabs.length, true); }
        else if (e.key === 'Home') { e.preventDefault(); go(0, true); }
        else if (e.key === 'End') { e.preventDefault(); go(tabs.length - 1, true); }
      });
    });
    go(0);
  });
})();

// Get help, the self-check: ticking all three shows how to reach us; ticking some says to write anyway.
// Nothing is stored or sent.
(() => {
  document.querySelectorAll('[data-check]').forEach(card => {
    const boxes = [...card.querySelectorAll('[data-check-i]')], all = card.querySelector('[data-ans="all"]'), some = card.querySelector('[data-ans="some"]');
    const update = () => {
      const n = boxes.filter(b => b.checked).length;
      all.hidden = n !== boxes.length;
      some.hidden = !(n > 0 && n < boxes.length);
    };
    boxes.forEach(b => b.addEventListener('change', update));
  });
})();

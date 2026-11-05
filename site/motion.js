(() => {
  // Native cross-document transitions slide the shared thumb without delaying navigation.
  if ('CSSViewTransitionRule' in window || !Element.prototype.animate) return;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const navigation = document.querySelector('.language-switch');
  const thumb = navigation?.querySelector('.language-thumb');
  if (!thumb) return;

  let pending = null;
  const reset = () => {
    const previous = pending;
    pending = null;
    if (previous) {
      clearTimeout(previous.timer);
      previous.animation?.cancel();
    }
  };
  navigation.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link || !navigation.contains(link) || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        (link.target && link.target.toLowerCase() !== '_self') || link.hasAttribute('download') ||
        preference.matches || new URL(link.href, location.href).origin !== location.origin) return;
    event.preventDefault();
    if (pending || link.getAttribute('aria-current') === 'page') return;

    const move = { href: link.href, navigated: false, animation: null, timer: null };
    pending = move;
    move.finish = () => {
      if (pending !== move || move.navigated) return;
      move.navigated = true;
      clearTimeout(move.timer);
      location.assign(move.href);
    };
    // A suspended animation must not hold up the requested page navigation.
    move.timer = setTimeout(move.finish, 400);
    try {
      move.animation = thumb.animate([
        { transform: getComputedStyle(thumb).transform },
        { transform: `translateX(${link.offsetLeft - thumb.offsetLeft}px)` }
      ], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
      move.animation.finished.then(move.finish, move.finish);
    } catch {
      move.finish();
    }
  });
  preference.addEventListener('change', () => {
    if (preference.matches && pending) {
      pending.finish();
      pending?.animation?.cancel();
    }
  });
  // Clear a completed or interrupted slide when this document returns from the back cache.
  window.addEventListener('pagehide', reset);
  window.addEventListener('pageshow', reset);
})();

(() => {
  // Qwen3-0.6B-Base read the whole page in one pass (scripts/build_attention.py). Resting the mouse on a word marks the
  // earlier words it attends to most, and on wide screens the right margin carries the page's strongest long-range links.
  const main = document.querySelector('main');
  if (!main || typeof fetch !== 'function' || typeof requestAnimationFrame !== 'function' || typeof ResizeObserver !== 'function' ||
      typeof document.createTreeWalker !== 'function' || typeof document.createRange !== 'function') return;
  const english = document.documentElement.lang === 'en';
  const mouse = matchMedia('(hover: hover) and (pointer: fine)');
  const wide = matchMedia('(min-width: 1300px)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let requested = false;
  const load = () => {
    if (requested || !(mouse.matches || wide.matches)) return;
    requested = true;
    fetch(`/assets/attention-page-${english ? 'en' : 'zh'}.json?v=11`)
      .then(response => response.ok ? response.json() : null)
      .then(data => data && build(data))
      .catch(() => {});
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(load, { timeout: 2500 });
  else setTimeout(load, 600);
  mouse.addEventListener('change', load);
  wide.addEventListener('change', load);

  // The page text as scripts/page_text.py reads it: text in <main> outside hidden parts, whitespace collapsed, a newline between blocks.
  function read() {
    const SKIP = 'svg,script,style,footer,template,[aria-hidden="true"],.attention-note';
    const BLOCK = 'address,article,aside,blockquote,dd,div,dl,dt,figcaption,figure,footer,h1,h2,h3,h4,h5,h6,header,li,main,nav,ol,p,section,ul,.contact-links > a,.resource-links > a';
    const space = char => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
    const nodes = [], where = [], offsets = new Map();
    let text = '', block = null, pending = false;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement, raw = node.data;
      if (!parent || parent.closest(SKIP)) continue;
      const own = parent.closest(BLOCK);
      if (own !== block) {
        if (!/[^ \t\n\r\f]/.test(raw)) continue;
        if (text) { text += '\n'; where.push(null); }
        block = own;
        pending = false;
      }
      const index = nodes.push(node) - 1, map = new Int32Array(raw.length).fill(-1);
      offsets.set(node, map);
      for (let offset = 0; offset < raw.length; offset++) {
        if (space(raw[offset])) {
          if (text && text[text.length - 1] !== '\n') pending = true;
          continue;
        }
        if (pending) { text += ' '; where.push(null); pending = false; }
        map[offset] = text.length;
        text += raw[offset];
        where.push([index, offset]);
      }
    }
    return { text, nodes, where, offsets };
  }

  // FNV-1a over UTF-16 code units, as scripts/page_text.py hashes the text the model read.
  function hash(text) {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
    return value.toString(16).padStart(8, '0');
  }

  function build(data) {
    const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const SVG = 'http://www.w3.org/2000/svg';
    const page = read(), text = page.text, code = data.tokens, n = typeof code === 'string' ? code.length : 0;
    if (!n || typeof data.links !== 'string' || typeof data.ambient !== 'string' || typeof data.cap !== 'number' ||
        text.length !== data.text_length || hash(text) !== data.text_hash) return;
    // Token t covers text from starts[t] to starts[t + 1]; the extra byte pieces of one character cover nothing.
    const starts = new Int32Array(n + 1), owner = new Int32Array(text.length);
    for (let t = 0; t < n; t++) {
      starts[t + 1] = starts[t] + DIGITS.indexOf(code[t]);
      if (starts[t + 1] < starts[t] || starts[t + 1] > text.length) return;
      owner.fill(t, starts[t], starts[t + 1]);
    }
    if (starts[n] !== text.length) return;
    // Each word keeps its strongest links to words more than data.near tokens back, on a square-root scale up to data.cap.
    const digit = (string, index) => DIGITS.indexOf(string[index]);
    const links = [];
    let at = 0;
    for (let t = 0; t < n; t++) {
      const count = digit(data.links, at++), row = [];
      for (let index = 0; index < count; index++, at += 3) {
        const key = digit(data.links, at) * 64 + digit(data.links, at + 1);
        if (!(key >= 0 && key < t)) return;
        row.push({ key, weight: data.cap * (digit(data.links, at + 2) / 63) ** 2 });
      }
      links.push(row);
    }
    if (at !== data.links.length) return;
    const arcs = [], byQuery = new Map();
    for (let index = 0; index + 5 <= data.ambient.length; index += 5) {
      const q = digit(data.ambient, index) * 64 + digit(data.ambient, index + 1), k = digit(data.ambient, index + 2) * 64 + digit(data.ambient, index + 3);
      if (!(k >= 0 && k < q && q < n)) return;
      const arc = { q, k, strength: digit(data.ambient, index + 4) / 63, path: null, y: 0, read: false };
      arcs.push(arc);
      if (!byQuery.has(q)) byQuery.set(q, []);
      byQuery.get(q).push(arc);
    }

    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'page-attention');
    svg.setAttribute('aria-hidden', 'true');
    const margin = document.createElementNS(SVG, 'g');
    margin.setAttribute('class', 'page-attention-margin');
    svg.append(margin);
    document.body.append(svg);
    const note = document.querySelector('.attention-note');
    if (note) note.hidden = false;
    const make = (tag, attributes, parent) => {
      const node = document.createElementNS(SVG, tag);
      for (const name in attributes) node.setAttribute(name, attributes[name]);
      parent.append(node);
      return node;
    };
    const fixed = value => value.toFixed(1);

    // Client rectangles of a token's visible characters, one range per run within a text node.
    const range = document.createRange();
    function boxes(t) {
      const found = [];
      let run = null;
      const flush = () => {
        if (!run) return;
        range.setStart(page.nodes[run.node], run.from);
        range.setEnd(page.nodes[run.node], run.to + 1);
        for (const rect of range.getClientRects()) if (rect.width && rect.height) found.push(rect);
        run = null;
      };
      for (let c = starts[t]; c < starts[t + 1]; c++) {
        const spot = page.where[c];
        if (!spot) { flush(); continue; }
        if (run && run.node === spot[0] && run.to === spot[1] - 1) run.to = spot[1];
        else { flush(); run = { node: spot[0], from: spot[1], to: spot[1] }; }
      }
      flush();
      return found;
    }

    // The word under the pointer, if it has links: the caret position names the character, and its token's boxes must hold the point.
    function hit(x, y) {
      let node = null, offset = 0;
      if (document.caretPositionFromPoint) {
        const caret = document.caretPositionFromPoint(x, y);
        if (caret) { node = caret.offsetNode; offset = caret.offset; }
      } else if (document.caretRangeFromPoint) {
        const caret = document.caretRangeFromPoint(x, y);
        if (caret) { node = caret.startContainer; offset = caret.startOffset; }
      }
      const map = node && page.offsets.get(node);
      if (!map) return -1;
      for (const spot of [offset, offset - 1]) {
        const c = spot >= 0 && spot < map.length ? map[spot] : -1;
        if (c < 0) continue;
        const t = owner[c];
        if (links[t].length && boxes(t).some(rect => x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1)) return t;
      }
      return -1;
    }

    let current = null, shown = -1, glowing = [];
    const retire = group => {
      if (!group) return;
      if (reduced.matches || !group.animate) { group.remove(); return; }
      group.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' }).finished.then(() => group.remove(), () => group.remove());
    };
    // The attended words get a wash in proportion to their weight, and a thin curve runs to each from the top of the word being read.
    function show(t, quiet) {
      const own = boxes(t);
      if (!own.length) { hide(); return; }
      const group = document.createElementNS(SVG, 'g');
      group.setAttribute('class', 'page-attention-focus');
      const top = Math.max(...links[t].map(link => link.weight));
      const qx = (own[0].left + own[0].right) / 2 + scrollX, qy = own[0].top + scrollY;
      for (const link of links[t]) {
        const parts = boxes(link.key), share = link.weight / top;
        if (!parts.length) continue;
        for (const part of parts) {
          make('rect', { x: fixed(part.left + scrollX - 2), y: fixed(part.top + scrollY), width: fixed(part.width + 4), height: fixed(part.height), rx: 3, 'fill-opacity': (.1 + .22 * share).toFixed(3) }, group);
        }
        const end = parts[parts.length - 1], kx = (end.left + end.right) / 2 + scrollX;
        let d;
        if (end.bottom + scrollY < qy - 2) {
          const ky = end.bottom + scrollY, bend = Math.min(160, (qy - ky) / 2);
          d = `M${fixed(qx)} ${fixed(qy)}C${fixed(qx)} ${fixed(qy - bend)} ${fixed(kx)} ${fixed(ky + bend)} ${fixed(kx)} ${fixed(ky)}`;
        } else {
          const ky = end.top + scrollY, lift = Math.min(qy, ky) - Math.min(36, 10 + Math.abs(qx - kx) * .15);
          d = `M${fixed(qx)} ${fixed(qy)}C${fixed(qx)} ${fixed(lift)} ${fixed(kx)} ${fixed(lift)} ${fixed(kx)} ${fixed(ky)}`;
        }
        make('path', { d, 'stroke-opacity': (.065 + .195 * share).toFixed(3), 'stroke-width': (.45 + .25 * share).toFixed(2) }, group);
      }
      for (const part of own) make('rect', { class: 'is-query', x: fixed(part.left + scrollX), y: fixed(part.bottom + scrollY + 1), width: fixed(part.width), height: 1, 'fill-opacity': .5 }, group);
      const previous = current;
      svg.append(group);
      current = group;
      shown = t;
      if (quiet) { if (previous) previous.remove(); }
      else {
        retire(previous);
        if (!reduced.matches && group.animate) group.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      }
      glowing.forEach(arc => arc.path && arc.path.classList.remove('is-lit'));
      glowing = (byQuery.get(t) || []).filter(arc => arc.path);
      glowing.forEach(arc => arc.path.classList.add('is-lit'));
    }
    function hide() {
      glowing.forEach(arc => arc.path && arc.path.classList.remove('is-lit'));
      glowing = [];
      retire(current);
      current = null;
      shown = -1;
    }

    // The margin arcs run from a word up to the earlier word it attends to; longer links bulge further out.
    function place() {
      hide();
      svg.style.height = '0px';
      const box = main.getBoundingClientRect();
      svg.style.height = `${Math.ceil(box.bottom + scrollY)}px`;
      margin.textContent = '';
      arcs.forEach(arc => { arc.path = null; });
      const left = box.right + 24, room = document.documentElement.clientWidth - left - 20;
      if (!wide.matches || room < 40) return;
      const reach = Math.min(130, room), x = left + scrollX;
      for (const arc of arcs) {
        const from = boxes(arc.q)[0], to = boxes(arc.k)[0];
        if (!from || !to) continue;
        const y1 = (from.top + from.bottom) / 2 + scrollY, y2 = (to.top + to.bottom) / 2 + scrollY, span = y1 - y2;
        if (span < 12) continue;
        // A parabola through both ends whose vertex stands out by the bulge: long links make wide, gentle bows.
        const bulge = 6 + (reach - 6) * (1 - Math.exp(-span / 1200));
        arc.y = y1;
        arc.path = make('path', { d: `M${fixed(x)} ${fixed(y1)}Q${fixed(x + 2 * bulge)} ${fixed((y1 + y2) / 2)} ${fixed(x)} ${fixed(y2)}`, pathLength: 1, 'stroke-opacity': (.045 + .155 * arc.strength).toFixed(3) }, margin);
        if (arc.read) arc.path.classList.add('is-read');
      }
      arcs.sort((a, b) => a.y - b.y);
    }
    // Arcs appear once the reader reaches the word they start from, drawn from that word back up to the earlier one.
    function reveal() {
      const line = scrollY + innerHeight * .85;
      let order = 0;
      for (const arc of arcs) {
        if (arc.read || !arc.path || (arc.y > line && !reduced.matches)) continue;
        arc.read = true;
        arc.path.classList.add('is-read');
        if (!reduced.matches && arc.path.animate) {
          arc.path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 1400, delay: Math.min(order++, 30) * 40, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' });
        }
      }
    }

    let point = null, frame = 0, timer = 0, wanted = -1, scrolled = false, revealing = false, placing = 0;
    function track() {
      frame = 0;
      if (!point || !mouse.matches) return;
      const t = hit(point.x, point.y), moved = scrolled;
      scrolled = false;
      if (t === wanted) {
        // Sticky headings move under a still pointer while the page scrolls.
        if (moved && t >= 0 && t === shown) show(t, true);
        return;
      }
      wanted = t;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (wanted !== t) return;
        if (t < 0) hide();
        else if (t !== shown) show(t);
      }, t < 0 ? 120 : shown >= 0 ? 60 : 150);
    }
    const leave = () => { point = null; wanted = -1; clearTimeout(timer); hide(); };
    document.addEventListener('pointermove', event => {
      if (event.pointerType !== 'mouse') return;
      if (event.buttons) { leave(); return; }
      point = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(track);
    }, { passive: true });
    document.addEventListener('mouseout', event => { if (!event.relatedTarget) leave(); });
    window.addEventListener('blur', leave);
    window.addEventListener('scroll', () => {
      scrolled = true;
      if (point && !frame) frame = requestAnimationFrame(track);
      if (!revealing) { revealing = true; requestAnimationFrame(() => { revealing = false; reveal(); }); }
    }, { passive: true });
    const schedule = () => { if (!placing) placing = requestAnimationFrame(() => { placing = 0; place(); reveal(); }); };
    new ResizeObserver(schedule).observe(main);
    window.addEventListener('resize', schedule);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  }
})();

(() => {
  // Keep navigation and language destinations attached to the content being read.
  if (!('IntersectionObserver' in window) || typeof document.querySelectorAll !== 'function') return;
  const header = document.querySelector('.site-header');
  const links = [...document.querySelectorAll('.section-links a[href^="#"]')];
  const sections = links.map(link => document.getElementById(link.hash.slice(1)));
  if (!header || !links.length || sections.some(section => !section)) return;
  const readingNav = document.querySelector('.reading-nav');
  const menu = readingNav?.querySelector('details');
  const summary = menu?.querySelector('summary');
  const label = readingNav?.querySelector('.reading-current');
  const menuLinks = readingNav ? [...readingNav.querySelectorAll('nav a')] : [];
  const languageLinks = readingNav ? [...document.querySelectorAll('a[hreflang]')] : [];
  const entries = readingNav ? [...document.querySelectorAll('.work-entry[id]')] : [];
  const compact = matchMedia('(max-width: 1080px)');
  let focusedLanguage = null;
  let queued = false;
  const update = () => {
    queued = false;
    header.classList.toggle('is-scrolled', scrollY > 4);
    const bottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
    const line = compact.matches ? 76 : 96;
    let current = -1;
    sections.forEach((section, index) => { if (section.getBoundingClientRect().top <= line + 8) current = index; });
    if (bottom && current >= 0) current = sections.length - 1;
    links.forEach((link, index) => {
      link.classList.toggle('is-current', index === current);
      if (index === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    if (!readingNav) return;

    let anchor = 'top';
    sections.forEach(section => { if (section.getBoundingClientRect().top <= line + 8) anchor = section.id; });
    const visibleEntry = entries.find(entry => {
      const rect = entry.getBoundingClientRect();
      return rect.bottom > line && rect.top <= Math.min(line + 100, innerHeight * .4);
    });
    if (visibleEntry) anchor = visibleEntry.id;
    // Focusing a sticky link can scroll its ancestor; keep the destination from before that focus.
    if (focusedLanguage && document.activeElement === focusedLanguage.link) anchor = focusedLanguage.anchor;
    languageLinks.forEach(link => {
      const destination = new URL(link.href, location.href);
      destination.hash = anchor === 'top' ? '' : anchor;
      link.href = destination.href;
    });

    readingNav.hidden = !compact.matches || sections[0].getBoundingClientRect().top > line + 8;
    if (readingNav.hidden) menu.open = false;
    label.textContent = links[Math.max(0, current)].textContent;
    menuLinks.forEach(link => {
      if (current >= 0 && link.hash === links[current].hash) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue);
  window.addEventListener('pageshow', queue);
  window.addEventListener('hashchange', queue);
  compact.addEventListener('change', queue);
  document.fonts?.ready.then(queue);
  // Update before normal link activation, including keyboard and modified clicks.
  languageLinks.forEach(link => {
    link.addEventListener('focus', () => { focusedLanguage = { link, anchor: new URL(link.href, location.href).hash.slice(1) || 'top' }; });
    link.addEventListener('blur', () => { focusedLanguage = null; queue(); });
    link.addEventListener('click', update, { capture: true });
  });
  const resumeReading = () => { focusedLanguage = null; queue(); };
  document.addEventListener('wheel', resumeReading, { passive: true });
  document.addEventListener('touchstart', resumeReading, { passive: true });
  menuLinks.forEach(link => link.addEventListener('click', () => { menu.open = false; }));
  if (menu) {
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) menu.open = false; });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.open) { menu.open = false; summary.focus(); }
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) resumeReading();
    });
  }
  update();
})();

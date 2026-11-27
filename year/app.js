// Year in Review page: the form, the progress bar, and the 1080 x 1350 card
// drawn on a canvas (a port of the card layout in the iOS app's
// YearRollupRenderer.swift, without the QR code). The card shows percentages
// and counts only; YearCore.text() is the only thing it reads.

(function () {
  'use strict';
  const Y = window.YearCore;
  const $ = (id) => document.getElementById(id);

  // ---------- site menu ----------
  const nb = $('siteNavBtn'), nm = $('siteNavMenu');
  nb.addEventListener('click', (e) => { e.stopPropagation(); const open = nm.classList.toggle('hidden') === false; nb.setAttribute('aria-expanded', open); });
  document.addEventListener('click', () => { nm.classList.add('hidden'); nb.setAttribute('aria-expanded', 'false'); });
  // Inside the iOS app's web view (?embed=1, remembered for the session) LP Yield stays hidden.
  let embedded = new URLSearchParams(location.search).get('embed') === '1';
  try { if (embedded) sessionStorage.setItem('ccEmbed', '1'); else embedded = sessionStorage.getItem('ccEmbed') === '1'; } catch (_) { /* storage blocked */ }
  if (!embedded) nm.querySelectorAll('a[data-app-hide]').forEach((a) => { a.hidden = false; });

  // ---------- inputs ----------
  const params = new URLSearchParams(location.search);
  const thisYear = new Date().getFullYear();
  let year = Y.reviewYear();
  const yParam = parseInt(params.get('year') || '', 10);
  if (yParam >= 2023 && yParam <= thisYear) year = yParam;
  $('yearLabel').textContent = String(year);
  $('go').textContent = `Make my ${year} Year in Review`;

  const fromURL = [params.get('wallet'), params.get('wallets')].filter(Boolean).join(',');
  if (fromURL) $('wallets').value = fromURL.split(/[\s,;]+/).filter(Boolean).join(', ');

  function parseWallets(text) {
    const parts = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const good = [], bad = [];
    for (const p of parts) (Y.isAddress(p) ? good : bad).push(p);
    return { good: [...new Set(good.map((a) => a.toLowerCase()))], bad };
  }

  // ---------- run ----------
  let ctl = null;
  let lastText = null;

  function show(id) {
    for (const s of ['intro', 'reading', 'result']) $(s).classList.toggle('hidden', s !== id);
  }

  async function run(wallets) {
    ctl = new AbortController();
    const mine = ctl;
    show('reading');
    setProgress({ fraction: 0, detail: 'Starting' });
    try {
      const r = await Y.build(wallets, { year, signal: mine.signal, progress: (p) => { if (ctl === mine) setProgress(p); } });
      if (ctl !== mine) return;
      lastText = Y.text(r);
      drawCard($('card'), lastText);
      $('card').setAttribute('aria-label', `${lastText.year} Year in Review card: ${lastText.storyTitle}. ${lastText.storyLine}. Your stack ${lastText.heroValue}.`);
      renderFacts(r, lastText);
      show('result');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (ctl !== mine) return;
      show('intro');
      $('formErr').textContent = e && e.message === 'Cancelled' ? '' : (e && e.message) || 'Something went wrong. Try again.';
    }
  }

  function setProgress(p) {
    const pct = Math.round(Math.max(0, Math.min(1, p.fraction)) * 100);
    $('bar').style.width = pct + '%';
    $('barWrap').setAttribute('aria-valuenow', String(pct));
    if (p.detail) $('detail').textContent = p.detail + (p.detail === 'Done' ? '' : '…');
  }

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('formErr').textContent = '';
    const { good, bad } = parseWallets($('wallets').value);
    if (bad.length) {
      const pls = bad.some((b) => /\.pls$/i.test(b));
      $('formErr').textContent = (pls ? '.pls names are not supported here yet: paste the 0x address. ' : '')
        + 'Not a wallet address: ' + bad.slice(0, 3).join(', ') + (bad.length > 3 ? '…' : '');
      return;
    }
    if (!good.length) { $('formErr').textContent = 'Paste at least one 0x wallet address.'; return; }
    if (good.length > 10) { $('formErr').textContent = 'Up to 10 wallets at a time.'; return; }
    run(good);
  });
  $('cancel').addEventListener('click', () => { if (ctl) ctl.abort(); ctl = null; show('intro'); });
  $('again').addEventListener('click', () => { show('intro'); $('wallets').focus(); });

  // ---------- facts list (counts and percentages only) ----------
  function renderFacts(r, t) {
    const plus = r.capped ? '+' : '';
    const n = (v) => new Intl.NumberFormat('en').format(v) + (v > 0 ? plus : '');
    const ch = (c) => (Math.abs(c) < 0.05 ? 'Unchanged' : Y.change(c));
    $('factStory').textContent = `${t.storyTitle}: ${t.storyLine}`;
    const rows = [['Your stack', t.heroValue]];
    for (const c of r.stacks.slice(0, 5)) {
      rows.push([`${c.symbol} stack`, c.changePercent != null ? ch(c.changePercent) : (c.end > 0 ? 'New' : '–')]);
    }
    // Read from the wallets' nonces when a list was cut short, so no + then.
    rows.push(['Transactions', r.transactionsExact ? new Intl.NumberFormat('en').format(r.transactions) : n(r.transactions)]);
    rows.push(['Active days', n(r.activeDays)]);
    const busiest = r.monthly.indexOf(Math.max(...r.monthly));
    if (r.transactions > 0) rows.push(['Busiest month', new Intl.DateTimeFormat('en', { month: 'long' }).format(new Date(r.year, busiest, 1))]);
    rows.push(['Swaps', n(r.swaps)]);
    if (r.cashOuts > 0) rows.push(['Swaps into stablecoins', n(r.cashOuts)]);
    if (r.topBuyMonths >= 2) rows.push([`Months buying ${r.topBuySymbol}`, `${r.topBuyMonths}/${r.monthsElapsed}`]);
    rows.push(['New HEX stakes', n(r.stakesStarted)]);
    rows.push(['HEX stakes ended', n(r.stakesEnded)]);
    for (const sl of r.stakeLengths || []) {
      const avg = (v, c) => `${Y.inDays(v)} (${new Intl.NumberFormat('en').format(c)} ${c === 1 ? 'stake' : 'stakes'})`;
      if (sl.newAverage != null) rows.push([`Avg new ${sl.symbol} stake`, avg(sl.newAverage, sl.newCount)]);
      if (sl.activeAverage != null) rows.push([`Avg ${sl.symbol} stake, all active`, avg(sl.activeAverage, sl.activeCount)]);
    }
    rows.push(['New LP positions', n(r.newLPPositions)]);
    rows.push(['Times you added liquidity', n(r.liquidityAdds)]);
    if (r.walletCount > 1) rows.push(['Wallets', String(r.walletCount)]);
    const dl = $('factList');
    dl.textContent = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.append(dt, dd);
    }
    // Why counts are marked +: the page limit, an explorer page that failed, or both.
    const notes = [];
    if (r.limited) notes.push('A wallet had more history than the page reads (1,500 transactions or transfers per list).');
    if (r.readFailed) notes.push('An explorer page didn\'t load, so some history wasn\'t read; trying again may fill it in.');
    notes.push(r.sentFromNonce && r.transactionsExact
      ? 'Transactions and the busiest month come from the wallet\'s own transaction count, so they are exact; other counts marked + are lower bounds.'
      : 'Counts marked + are lower bounds.');
    $('cappedNote').textContent = notes.join(' ');
    $('cappedNote').classList.toggle('hidden', !r.capped);
  }

  // ---------- card ----------
  const PAL = { pink: '#FF2E9A', violet: '#C63BFF', blue: '#5B7BFF', cyan: '#00D9FF', night: '#07080F' };
  const W = 1080, H = 1350, MARGIN = 84;
  const FONT = 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const WEIGHT = { medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 };
  const white = (a) => `rgba(255,255,255,${a})`;
  const rgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  function brandGradient(ctx, x0, y0, x1, y1, alpha = 1) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, rgba(PAL.pink, alpha));
    g.addColorStop(0.36, rgba(PAL.violet, alpha));
    g.addColorStop(0.68, rgba(PAL.blue, alpha));
    g.addColorStop(1, rgba(PAL.cyan, alpha));
    return g;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else {
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
  }

  /**
   * One line of text, baseline at y. Shrinks the font until it fits maxWidth.
   * fill: a CSS colour, or { brand: true, glow } for the brand gradient.
   */
  function text(ctx, s, o) {
    if (!s) return 0;
    let pt = o.size;
    const kern = o.kern || 0;
    const setFont = () => {
      ctx.font = `${WEIGHT[o.weight] || 600} ${pt}px ${FONT}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = (kern * pt / o.size) + 'px';
    };
    setFont();
    let width = ctx.measureText(s).width;
    if (o.maxWidth && width > o.maxWidth) {
      pt = Math.floor(pt * o.maxWidth / width);
      setFont();
      width = ctx.measureText(s).width;
    }
    const align = o.align || 'center';
    const x0 = align === 'left' ? o.x : align === 'right' ? o.x - width : o.x - width / 2;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (o.fill && o.fill.brand) {
      const ascent = pt * 0.75;
      if (o.fill.glow) {
        ctx.save();
        ctx.shadowColor = rgba(PAL.violet, Math.min(1, 0.55 * o.fill.glow));
        ctx.shadowBlur = pt * 0.45;
        ctx.fillStyle = PAL.violet;
        ctx.fillText(s, x0, o.y);
        ctx.restore();
      }
      ctx.fillStyle = brandGradient(ctx, x0, o.y - ascent, x0 + width, o.y);
      ctx.fillText(s, x0, o.y);
    } else {
      ctx.fillStyle = o.fill || '#fff';
      ctx.fillText(s, x0, o.y);
    }
    ctx.restore();
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    return width;
  }

  function panel(ctx, x, y, w, h, r) {
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = white(0.06);
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = brandGradient(ctx, x, y, x + w, y + h, 0.7);
    ctx.stroke();
    ctx.restore();
  }

  function background(ctx) {
    ctx.fillStyle = PAL.night;
    ctx.fillRect(0, 0, W, H);
    const orb = (hex, cx, cy, r, a) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, rgba(hex, a));
      g.addColorStop(1, rgba(hex, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    };
    orb(PAL.pink, W * 0.1, H * 0.12, W * 0.75, 0.26);
    orb(PAL.violet, W * 0.95, H * 0.45, W * 0.7, 0.2);
    orb(PAL.cyan, W * 0.25, H * 0.95, W * 0.8, 0.16);
  }

  /** Transactions per month as 12 bars; months still to come are faint stubs. */
  function monthBars(ctx, t, x, y, w, h, letterSize) {
    const n = 12, gap = Math.round(w * 0.022), bw = (w - gap * (n - 1)) / n;
    const hi = Math.max(1, ...t.monthly), stub = 8, maxY = y + h;
    const bars = [];
    for (let i = 0; i < n; i++) {
      const bx = x + i * (bw + gap);
      const v = t.monthly[i] || 0;
      const future = i >= t.monthsElapsed;
      if (v > 0 && !future) {
        const bh = Math.max(stub, h * v / hi);
        bars.push([bx, maxY - bh, bw, bh]);
      } else {
        ctx.fillStyle = white(future ? 0.06 : 0.16);
        roundRect(ctx, bx, maxY - stub, bw, stub, 4);
        ctx.fill();
      }
      text(ctx, t.monthLetters[i], { size: letterSize, weight: 'semibold', x: bx + bw / 2, y: maxY + letterSize * 1.35, fill: white(future ? 0.22 : 0.5) });
    }
    if (!bars.length) return;
    const path = () => { ctx.beginPath(); for (const [bx, by, bw2, bh] of bars) { if (ctx.roundRect) ctx.roundRect(bx, by, bw2, bh, Math.min(10, bw2 / 3)); else ctx.rect(bx, by, bw2, bh); } };
    ctx.save();
    ctx.shadowColor = rgba(PAL.violet, 0.8);
    ctx.shadowBlur = 22;
    ctx.fillStyle = PAL.violet;
    path(); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = brandGradient(ctx, x, 0, x + w, 0);
    path(); ctx.fill();
    ctx.restore();
  }

  function statPanel(ctx, s, x, y, w, h) {
    panel(ctx, x, y, w, h, 36);
    const inner = w - 32, cx = x + w / 2;
    const top = y + h * (s.note ? 0.3 : 0.36);
    text(ctx, s.label, { size: 26, weight: 'semibold', x: cx, y: top, fill: white(0.62), maxWidth: inner });
    text(ctx, s.value, { size: 52, weight: 'heavy', x: cx, y: top + 52 * 1.12, fill: { brand: true, glow: 0.9 }, maxWidth: inner });
    if (s.note) text(ctx, s.note, { size: 24, weight: 'medium', x: cx, y: y + h - 18, fill: white(0.75), maxWidth: inner });
  }

  // 4:5 card: the year, its story, the stack change, a bar per month, three
  // stats, then the call to action.
  function drawCard(canvas, t) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    background(ctx);
    const full = W - MARGIN * 2;
    text(ctx, '₵HING ₵HING', { size: 34, weight: 'bold', x: W / 2, y: 120, fill: { brand: true }, kern: 8 });
    text(ctx, t.year, { size: 150, weight: 'black', x: W / 2, y: 270, fill: { brand: true, glow: 1.6 }, maxWidth: full });
    text(ctx, t.title, { size: 50, weight: 'semibold', x: W / 2, y: 348, fill: white(0.92), maxWidth: full });

    text(ctx, t.storyTitle, { size: 70, weight: 'heavy', x: W / 2, y: 452, fill: { brand: true, glow: 1.2 }, maxWidth: full });
    text(ctx, t.storyLine, { size: 32, weight: 'medium', x: W / 2, y: 452 + 32 * 1.75, fill: white(0.88), maxWidth: full });

    text(ctx, t.heroLabel.toUpperCase(), { size: 28, weight: 'semibold', x: W / 2, y: 590, fill: white(0.6), kern: 4 });
    text(ctx, t.heroValue, { size: 116, weight: 'heavy', x: W / 2, y: 704, fill: '#fff', maxWidth: full });
    text(ctx, t.heroNote, { size: 26, weight: 'medium', x: W / 2, y: 748, fill: white(0.55), maxWidth: full });
    monthBars(ctx, t, MARGIN + 40, 782, full - 80, 84, 22);

    const stats = t.stats.slice(0, 3);
    if (stats.length) {
      const gap = 24, pw = (full - gap * (stats.length - 1)) / stats.length;
      stats.forEach((s, i) => statPanel(ctx, s, MARGIN + i * (pw + gap), 932, pw, 150));
    }

    panel(ctx, MARGIN, 1116, full, 150, 36);
    text(ctx, t.ctaTitle, { size: 40, weight: 'bold', x: W / 2, y: 1180, fill: white(0.95), maxWidth: full - 64 });
    text(ctx, t.ctaSubtitle, { size: 32, weight: 'semibold', x: W / 2, y: 1232, fill: { brand: true }, maxWidth: full - 64 });

    text(ctx, t.period, { size: 26, weight: 'medium', x: MARGIN, y: 1310, align: 'left', fill: white(0.5), maxWidth: full / 2 });
    text(ctx, 'Ching Ching for iPhone', { size: 26, weight: 'medium', x: W - MARGIN, y: 1310, align: 'right', fill: white(0.5), maxWidth: full / 2 });
  }

  // ---------- save and share ----------
  const fileName = () => `Ching Ching ${lastText ? lastText.year : year} Card.png`;
  const cardBlob = () => new Promise((resolve) => $('card').toBlob((b) => resolve(b), 'image/png'));

  $('download').addEventListener('click', async () => {
    const blob = await cardBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  // Share appears only where the browser can share a file (iOS, Android, some desktops).
  try {
    const probe = new File([new Blob([''], { type: 'image/png' })], 'probe.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [probe] })) $('share').classList.remove('hidden');
  } catch (_) { /* no File constructor or no Web Share */ }
  $('share').addEventListener('click', async () => {
    const blob = await cardBlob();
    if (!blob) return;
    const file = new File([blob], fileName(), { type: 'image/png' });
    try {
      await navigator.share({ files: [file], title: `My ${lastText.year} Year in Review`, text: 'Made with Ching Ching: https://chingching.xyz/year/' });
    } catch (_) { /* cancelled */ }
  });

  // ---------- boot ----------
  if (fromURL) {
    const { good, bad } = parseWallets(fromURL);
    if (good.length && !bad.length && good.length <= 10) run(good);
  }
})();

/* LP Yield page: tracked wallets, claimable V3 fees on 9mm, LibertySwap and
 * Switch, compounding, adding the wallet's own tokens to a position, and
 * sending a position to another address.
 * Maths, ABI and chain reads live in yield-core.js.
 */
(function () {
  'use strict';
  const Y = window.YieldCore;
  const $ = (id) => document.getElementById(id);

  // ---------- storage (this browser only) ----------
  const K = { wallets: 'ccYield.wallets', prefs: 'ccYield.prefs', rdns: 'ccYield.walletRdns' };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };

  const DEFAULT_PREFS = {
    view: 'positions', sort: 'claimable', dir: 'desc', wallet: 'all', chain: 'all', dex: 'all', q: '', inRange: false, minClaim: 0,
    mask: false, slippageBps: 100, approve: 'exact', unwrapNative: false, byPair: true,
  };
  const loadedWallets = store.get(K.wallets, []);
  const state = {
    wallets: Array.isArray(loadedWallets) ? loadedWallets.filter((w) => w && Y.isAddress(w.address)) : [],
    prefs: Object.assign({}, DEFAULT_PREFS, store.get(K.prefs, {})),
    positions: [], groups: [], plsUsd: 0, nativeUsd: {},
    loading: false, error: null, notice: null, dexErrors: {}, updatedAt: null, seq: 0,
    providers: [], provider: null, account: null, chainId: null, pickerOpen: false, netMenuOpen: false, switching: false,
    status: {}, // group key -> { text, kind }
    running: false,
    funds: null, // connected wallet's balances of its pairs' tokens, for Add (loadFunds)
  };
  const savePrefs = () => store.set(K.prefs, state.prefs);
  const saveWallets = () => store.set(K.wallets, state.wallets);

  // ---------- formatting ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmtUsd(v) {
    if (!Number.isFinite(v) || v === 0) return '$0.00';
    if (Math.abs(v) < 0.01) return '<$0.01';
    return usdFmt.format(v);
  }
  function fmtAmt(x) {
    if (!Number.isFinite(x) || x === 0) return '0';
    const a = Math.abs(x);
    if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return Math.round(x).toLocaleString('en-US');
    if (a >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
    // Wei-scale dust ("0.000000000000114 WPLS" left over by a compound) reads as noise.
    if (a < 1e-9) return '≈0';
    // Significant digits without exponent notation: 0.00000065, not 6.50e-7.
    return x.toLocaleString('en-US', { maximumSignificantDigits: 3 });
  }
  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 10000) return '>9,999%';
    return (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1)) + '%';
  }
  // Whole dollars from $100 up: the IL cell holds two signed amounts in a narrow column.
  const fmtSigned = (v) => (v < 0 ? '−' : '+') + (Math.abs(v) >= 100 ? '$' + Math.round(Math.abs(v)).toLocaleString('en-US') : fmtUsd(Math.abs(v)));
  /** APR compounded daily, for the Est. APR tooltip only. */
  const dailyApy = (apr) => (Math.pow(1 + apr / 100 / 365, 365) - 1) * 100;
  const feePct = (tier) => (tier / 10000).toString() + '%';
  const shortAddr = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }
  function walletIndex(addr) { return state.wallets.findIndex((w) => w.address === addr); }
  function walletName(addr) {
    const i = walletIndex(addr);
    const w = state.wallets[i];
    if (w && w.label) return w.label;
    return state.prefs.mask ? 'Wallet ' + (i + 1) : shortAddr(addr);
  }
  const isMine = (addr) => state.account && state.account === addr;

  // ---------- data ----------
  async function refresh() {
    const seq = ++state.seq;
    state.loading = true; state.error = null;
    renderSummary();
    renderList();
    renderBanner();
    try {
      const owners = state.wallets.map((w) => w.address);
      if (!owners.length) {
        state.positions = []; state.groups = [];
        return;
      }
      const { positions, plsUsd, nativeUsd, errors } = await Y.fetchPositions(owners);
      const fees = positions.length
        ? await Y.fetchFees(positions.map((p) => ({ id: p.id, owner: p.owner, nfpm: Y.DEXES[p.dex].nfpm, chain: Y.DEXES[p.dex].chain })))
        : [];
      if (seq !== state.seq) return;
      state.dexErrors = errors;
      // Every DEX failing is a failed refresh; keep the last good numbers.
      if (Object.keys(errors).length === Object.keys(Y.DEXES).length) throw new Error(Object.values(errors)[0]);
      state.positions = positions.map((p, i) => Y.buildPosition(p, fees[i]));
      state.groups = Y.buildGroups(state.positions);
      state.plsUsd = plsUsd;
      state.nativeUsd = nativeUsd || {};
      state.updatedAt = Date.now();
    } catch (e) {
      if (seq === state.seq) state.error = e.message || String(e);
    } finally {
      if (seq === state.seq) { state.loading = false; render(); }
    }
    if (seq === state.seq) loadFunds();
  }

  /**
   * The connected wallet's balances of every token in its own positions'
   * pairs, plus native and the gas price, one RPC batch per chain. Only
   * decides whether a row offers Add; the Add itself reads them again.
   * Public RPC nodes, no Worker.
   */
  async function loadFunds() {
    const acct = state.account;
    const seq = (state.fundsSeq = (state.fundsSeq || 0) + 1);
    if (!acct) { state.funds = null; return; }
    const byChain = {};
    for (const p of state.positions) {
      if (p.owner !== acct) continue;
      const c = byChain[p.chain] || (byChain[p.chain] = new Set());
      c.add(p.token0.address); c.add(p.token1.address);
    }
    const out = { account: acct, byChain: {} };
    await Promise.all(Object.entries(byChain).map(async ([key, set]) => {
      const tokens = [...set];
      const reqs = tokens.map((t) => ({ method: 'eth_call', params: [{ to: t, data: Y.SEL.balanceOf + Y.addrWord(acct) }, 'latest'] }));
      reqs.push({ method: 'eth_getBalance', params: [acct, 'latest'] }, { method: 'eth_gasPrice', params: [] });
      try {
        const res = await Y.rpcBatch(reqs, Y.chainOf(key).rpcs);
        const val = (r) => (r && !r.error && r.result && r.result !== '0x' ? BigInt(r.result.slice(0, 66)) : null);
        const price = val(res[res.length - 1]), native = val(res[res.length - 2]);
        if (price == null || native == null) return;
        const bal = {};
        tokens.forEach((t, i) => { const v = val(res[i]); if (v != null) bal[t] = v; });
        out.byChain[key] = { tokens: bal, native, price };
      } catch (_) { /* no Add buttons on this chain until the next refresh */ }
    }));
    if (seq !== state.fundsSeq || state.account !== acct) return;
    state.funds = out;
    renderList();
  }

  // ---------- filtering & sorting ----------
  /** Claimable as displayed (rounded to the cent), so the Min claim filter
   *  agrees with what the row shows: $0.4863 reads "$0.49" and must pass a
   *  $0.49 filter. */
  // Parsed from the formatter itself: Math.round(1.005 * 100) gives 100 while
  // the row shows "$1.01", so arithmetic rounding can still disagree.
  const shownCents = (usd) => Number(usdFmt.format(usd).replace(/[^0-9.-]/g, ''));
  function passes(p) {
    const f = state.prefs;
    if (f.wallet !== 'all' && p.owner !== f.wallet) return false;
    if (f.chain !== 'all' && p.chain !== f.chain) return false;
    if (f.dex !== 'all' && p.dexLabel !== f.dex) return false;
    if (f.inRange && !p.inRange) return false;
    if (f.minClaim > 0 && shownCents(p.claimUsd) < f.minClaim) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      const pair = (p.token0.symbol + '/' + p.token1.symbol).toLowerCase();
      if (!pair.includes(q) && !p.id.includes(q)) return false;
    }
    return true;
  }
  const nz = (v) => (v == null || !Number.isFinite(v) ? -1 : v);
  function sorter(kind) {
    const f = state.prefs, dir = f.dir === 'asc' ? 1 : -1;
    const key = {
      claimable: (x) => x.claimUsd,
      apr: (x) => nz(kind === 'group' ? (x.target ? x.target.estApr : null) : x.estApr),
      poolApr: (x) => nz(kind === 'group' ? (x.target ? x.target.poolApr : null) : x.poolApr),
      value: (x) => x.value,
      // Unknown IL goes last whichever way you sort: ascending (worst first) is the useful one.
      net: (x) => (x.netUsd == null ? (f.dir === 'asc' ? Infinity : -Infinity) : x.netUsd),
      pair: (x) => (x.token0.symbol + '/' + x.token1.symbol).toLowerCase(),
      wallet: (x) => walletName(x.owner).toLowerCase(),
    }[f.sort] || ((x) => x.claimUsd);
    return (a, b) => {
      const ka = key(a), kb = key(b);
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
      return b.claimUsd - a.claimUsd;
    };
  }

  // ---------- rendering ----------
  function render() {
    renderConnect();
    renderSummary();
    renderChips();
    renderControls();
    renderList();
    renderBanner();
  }

  function renderBanner() {
    const el = $('banner');
    const partial = Object.entries(state.dexErrors || {});
    if (state.noticeHtml) el.innerHTML = `<div class="banner info">${state.noticeHtml}</div>`; // built from escaped parts in runSend
    else if (state.notice) el.innerHTML = `<div class="banner info">${esc(state.notice)}</div>`;
    else if (state.error) el.innerHTML = `<div class="banner bad">Couldn't load positions: ${esc(state.error)}. Try Refresh.</div>`;
    else if (partial.length) {
      el.innerHTML = `<div class="banner bad">${partial.map(([dex, msg]) => `Couldn't load ${esc(Y.DEXES[dex].errorLabel || Y.DEXES[dex].label)} (${esc(msg)})`).join('; ')}. Other DEXes are shown; try Refresh.</div>`;
    } else el.innerHTML = '';
  }

  function renderSummary() {
    const all = state.positions;
    const shown = all.filter(passes);
    const total = all.reduce((s, p) => s + p.claimUsd, 0);
    const shownTotal = shown.reduce((s, p) => s + p.claimUsd, 0);
    const value = shown.reduce((s, p) => s + p.value, 0);
    let wSum = 0, wVal = 0;
    for (const p of shown) if (p.estApr != null) { wSum += p.estApr * p.value; wVal += p.value; }
    const avgApr = wVal > 0 ? wSum / wVal : null;
    const perDay = avgApr != null ? (value * avgApr) / 100 / 365 : null;
    const filtered = shown.length !== all.length;
    const walletsWithPos = new Set(all.map((p) => p.owner)).size;
    const errs = all.filter((p) => p.feeError).length;
    // Net over the shown positions that have one (9mm, Switch and LibertySwap on PulseChain so far).
    const withNet = shown.filter((p) => p.netUsd != null);
    const net = withNet.reduce((s, p) => s + p.netUsd, 0);
    const netTip = 'Net against holding: fees earned plus impermanent loss, summed over '
      + (withNet.length === shown.length ? 'these positions.' : `the ${withNet.length} of ${shown.length} positions it can be worked out for (9mm, Switch and LibertySwap on PulseChain so far).`)
      + ' Click a row\'s Net for the working.';

    $('summary').className = 'panel summary' + (state.loading ? ' loading' : '');
    $('summary').innerHTML = `
      <div>
        <div class="claim-label">Claimable now</div>
        <div class="claim-total">${state.updatedAt || !state.loading ? fmtUsd(total) : '…'}</div>
        <div class="claim-sub">${all.length} position${all.length === 1 ? '' : 's'} in ${walletsWithPos} wallet${walletsWithPos === 1 ? '' : 's'}${filtered ? ` · <b style="color:var(--gold)">${fmtUsd(shownTotal)}</b> in current filter` : ''}${errs ? ` · <span class="err">${errs} fee read${errs === 1 ? '' : 's'} failed</span>` : ''}</div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">LP value${filtered ? ' (shown)' : ''}</div><div class="v">${fmtUsd(value)}</div></div>
        <div class="stat" title="${esc(netTip)}"><div class="k">Net vs holding</div><div class="v ${withNet.length ? signCls(net) : ''}">${withNet.length ? fmtSigned(net) : '—'}</div>${withNet.length && withNet.length < shown.length ? `<div class="s">${withNet.length} of ${shown.length} positions</div>` : ''}</div>
        <div class="stat"><div class="k">Avg est. APR</div><div class="v">${fmtPct(avgApr)}</div></div>
        <div class="stat"><div class="k">Est. fees / day</div><div class="v">${perDay == null ? '—' : fmtUsd(perDay)}</div></div>
      </div>
      <div class="refresh">
        <button class="btn" id="refreshBtn" type="button" ${state.loading ? 'disabled' : ''}>
          <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
          ${state.loading ? 'Refreshing' : 'Refresh'}
        </button>
        <div class="updated" id="updatedAt">Updated ${ago(state.updatedAt)}</div>
      </div>`;
    $('refreshBtn').addEventListener('click', refresh);
  }

  function renderChips() {
    const totals = {};
    for (const p of state.positions) totals[p.owner] = (totals[p.owner] || 0) + p.claimUsd;
    const f = state.prefs;
    $('maskBtn').textContent = f.mask ? 'Show addresses' : 'Hide addresses';
    if (!state.wallets.length) {
      $('chips').innerHTML = '<div class="meta">No wallets yet. Add one above, or connect a wallet and track it.</div>';
      return;
    }
    $('chips').innerHTML = state.wallets.map((w, i) => {
      const on = f.wallet === w.address;
      const label = w.label || (f.mask ? 'Wallet ' + (i + 1) : '');
      return `<div class="chip${on ? ' on' : ''}" data-act="filterWallet" data-addr="${w.address}" title="${on ? 'Show all wallets' : 'Show only this wallet'}">
        ${label ? `<span class="nm">${esc(label)}</span>` : ''}
        ${f.mask ? '' : `<span class="ad mono">${shortAddr(w.address)}</span>`}
        ${isMine(w.address) ? '<span class="me">CONNECTED</span>' : ''}
        <span class="cv">${state.updatedAt ? fmtUsd(totals[w.address] || 0) : ''}</span>
        <button class="ic" type="button" data-act="rename" data-addr="${w.address}" title="Rename" aria-label="Rename">✎</button>
        <button class="ic" type="button" data-act="remove" data-addr="${w.address}" title="Stop tracking" aria-label="Stop tracking">×</button>
      </div>`;
    }).join('');
  }

  function renderControls() {
    const f = state.prefs;
    $('byPairChk').checked = f.byPair;
    $('sortSel').value = f.sort;
    $('dirBtn').textContent = f.dir === 'desc' ? '↓ High first' : '↑ Low first';
    if (document.activeElement !== $('qInput')) $('qInput').value = f.q;
    $('dexSel').value = f.dex;
    $('chainSel').value = f.chain;
    $('inRangeChk').checked = f.inRange;
    if (document.activeElement !== $('minClaim')) $('minClaim').value = f.minClaim || '';
  }

  function th(label, key, cls = '') {
    const f = state.prefs;
    const sorted = f.sort === key;
    const arrow = sorted ? (f.dir === 'desc' ? ' ↓' : ' ↑') : '';
    return key
      ? `<button type="button" class="th ${cls}${sorted ? ' sorted' : ''}" data-act="sort" data-key="${key}">${label}${arrow}</button>`
      : `<div class="th nosort ${cls}">${label}</div>`;
  }

  function claimCell(x) {
    if (x.feeError && !x.claimUsd) return `<div class="err" title="${esc(x.feeError)}">fee read failed</div>`;
    return `<div class="claim-usd">${fmtUsd(x.claimUsd)}</div>
      <div class="claim-tok"><span>${fmtAmt(x.fee0)} ${esc(x.token0.symbol)}</span> + <span>${fmtAmt(x.fee1)} ${esc(x.token1.symbol)}</span></div>`;
  }

  function aprTip(p) {
    let t = "This position's share of the pool's fees yesterday, annualised. Blank when there's no recent pool data or the estimate is implausible (over 1000%).";
    if (p.estApr > 0) {
      t += `\n\n≈${fmtPct(dailyApy(p.estApr))} APY if compounded daily with every fee going back in. `
        + "Fees that don't fit the range's ratio stay in your wallet, so the real figure sits between the two.";
    }
    return t;
  }

  /**
   * What the position holds: token amounts, and a bar splitting its value
   * between the two (all one colour when it's out of range).
   */
  function compositionHtml(p) {
    const v0 = p.amt0 * p.token0.usd, v1 = p.amt1 * p.token1.usd, tot = v0 + v1;
    const pct0 = tot > 0 ? Math.round((v0 / tot) * 100) : null;
    const split = pct0 == null ? '' : `${pct0}% ${p.token0.symbol} · ${100 - pct0}% ${p.token1.symbol} by value`;
    return `<div class="comp" title="${esc(split)}"><span>${fmtAmt(p.amt0)} <span class="c0">${esc(p.token0.symbol)}</span></span> + <span>${fmtAmt(p.amt1)} <span class="c1">${esc(p.token1.symbol)}</span></span></div>`
      + (pct0 == null ? '' : `<div class="comp-bar" title="${esc(split)}"><span style="width:${pct0}%"></span></div>`);
  }

  const signCls = (v) => (v < 0 ? 'neg' : 'pos');
  const fmtSignedPct = (v) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(1) + '%';
  const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  /** Why a row has no Net, for the "—" tooltip and the popover. */
  function netUnknownWhy(p) {
    if (!p.hasHistory) return "Needs the position's history, which only 9mm, Switch and LibertySwap on PulseChain provide so far.";
    if (!(p.token0.usd > 0) || !(p.token1.usd > 0)) {
      return `${!(p.token0.usd > 0) ? p.token0.symbol : p.token1.symbol} has no price, so what holding would be worth can't be worked out.`;
    }
    return "The position's history couldn't be read (or its price when this wallet received it), so it can't be compared with holding.";
  }

  /**
   * Net against holding, with the impermanent loss written out under it. The
   * whole cell opens a popover with the working (openNetPop).
   */
  function netCell(p) {
    const h = p.hist;
    if (!h) return `<span class="dim" title="${esc(netUnknownWhy(p))}">—</span>`;
    return `<button type="button" class="net-cell" data-act="net" data-uid="${esc(p.uid)}" aria-haspopup="dialog" title="How this is worked out">`
      + `<span class="il ${h.netUsd == null ? '' : signCls(h.netUsd)}">${h.netUsd == null ? '—' : fmtSigned(h.netUsd)}</span>`
      + `<span class="claim-tok il-net">IL <span class="${signCls(h.ilTotalUsd)}">${fmtSigned(h.ilTotalUsd)}</span>`
      + `${h.ilPct == null ? '' : ` <span class="il-pct">${fmtSignedPct(h.ilPct)}</span>`}</span>`
      + '</button>';
  }

  function closeNetPop() {
    const el = $('netPop');
    if (el) el.remove();
    state.netPopUid = null;
  }

  function openNetPop(anchor, p) {
    closeNetPop();
    const h = p.hist, s0 = p.token0.symbol, s1 = p.token1.symbol;
    const toks = (a, b) => `${fmtAmt(a)} ${esc(s0)} + ${fmtAmt(b)} ${esc(s1)}`;
    // One line of the sum: operator, label with a note under it, amount.
    const row = (op, k, v, sub, cls = '') => `<div class="kv pop-row${cls}"><span class="op">${op}</span>`
      + `<span class="k">${k}${sub ? `<span class="pop-sub">${sub}</span>` : ''}</span><span class="v">${v}</span></div>`;
    const signed = (v) => `<span class="${signCls(v)}">${fmtSigned(v)}</span>`;
    const g = pairGroupOf(p), n = g ? g.positions.length : 1;
    const pct = h.ilPct == null ? '' : ` <span class="il-pct">${fmtSignedPct(h.ilPct)}</span>`;
    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.id = 'netPop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Net against holding');
    pop.innerHTML = `
      <div class="pop-h">${esc(s0)} / ${esc(s1)} <span class="pop-dim">#${esc(p.id)} · ${esc(p.dexLabel)} · ${esc(walletName(p.owner))}</span></div>
      <div class="pop-note">How this position has done against simply keeping the tokens that went into it, since ${fmtDate(h.since)} (${h.received ? 'when this wallet received it' : 'when it was opened'}).</div>
      ${row('', 'Value in the pool now', fmtUsd(p.value), toks(p.amt0, p.amt1))}
      ${row('−', 'Value if you had held instead', fmtUsd(h.heldUsd), toks(h.held0, h.held1) + ': what went in, kept in the wallet')}
      ${h.withdrawals
        ? row('+', `IL already taken out`, signed(h.realisedUsd), `on ${h.withdrawals} withdrawal${h.withdrawals > 1 ? 's' : ''} (${toks(h.out0, h.out1)} came out)`)
        : ''}
      ${row('=', 'IL (impermanent loss)', signed(h.ilTotalUsd) + pct, h.ilPct == null ? '' : '% of everything that went in', ' pop-strong')}
      ${h.earnedUsd == null
        ? row('+', 'Fees earned', '—', "this position's unclaimed fees couldn't be read")
        : row('+', 'Fees earned', signed(h.earnedUsd), toks(h.earned0, h.earned1) + ', collected and unclaimed')}
      ${row('=', 'Net against holding', h.netUsd == null ? '—' : signed(h.netUsd), 'what providing liquidity has made you, over just holding', ' pop-total')}
      ${n > 1 && g.netUsd != null ? row('', `${n === 2 ? 'Both' : `All ${n}`} ${esc(s0)}/${esc(s1)} positions here`, signed(g.netUsd), `net against holding, ${esc(walletName(p.owner))} on ${esc(p.dexLabel)}`) : ''}
      <div class="pop-note"><b>IL</b> is what the pool's rebalancing has cost as the price moved: it sells the token that's rising for the one that's falling. It's "impermanent" because it shrinks if the price comes back, and becomes real when you withdraw.</div>
      <div class="pop-note">"If you had held" counts ${h.received ? 'what the position held when it arrived' : 'the tokens it was opened with'}, plus every add (compounded fees included), less the share taken out with each withdrawal. Both values use the pool's current price; fees use market prices.</div>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, ht = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + ht > innerHeight - 8 && r.top - ht - 6 > 8) top = r.top - ht - 6;
    pop.style.left = left + scrollX + 'px';
    pop.style.top = top + scrollY + 'px';
    state.netPopUid = p.uid;
  }

  function renderList() {
    closeNetPop(); // its row is about to be replaced
    const el = $('list');
    if (!state.wallets.length) {
      el.innerHTML = `<div class="empty">Add the wallets you provide V3 liquidity from, on PulseChain or Ethereum.<br>They'll be remembered in this browser, and fees reload each time you open the page.</div>`;
      return;
    }
    if (state.loading && !state.updatedAt) { el.innerHTML = '<div class="empty">Loading positions…</div>'; return; }
    if (!state.positions.length) {
      el.innerHTML = state.updatedAt ? '<div class="empty">No open V3 positions in these wallets on the supported DEXes.</div>' : '';
      return;
    }
    renderPositions(el);
  }

  function renderPositions(el) {
    const rows = state.positions.filter(passes).sort(sorter('position'));
    // TARGET marks where by-pair compounding sends a pair's fees; meaningless with it off.
    const targets = new Set(state.prefs.byPair ? state.groups.filter((g) => g.target && g.positions.length > 1).map((g) => g.target.uid) : []);
    el.innerHTML = `<div class="tbl pos">
      <div class="thead"><div class="tr">
        ${th('Pair', 'pair')}${th('Wallet', 'wallet')}${th('Range', '')}${th('Value', 'value', 'num')}${th('Est. APR', 'apr', 'num')}${th('Pool APR', 'poolApr', 'num')}${th('Net', 'net', 'num')}${th('Claimable', 'claimable', 'num')}${th('', '', 'num')}
      </div></div>
      <div class="tbody">${rows.map((p) => {
        const cg = actionGroup(p, 'compound'), chk = canCompound(cg), add = addOffer(p);
        const col = canCompound(actionGroup(p, 'collect'));
        const busy = state.running, st = state.status[p.uid];
        const others = cg.positions.length - 1;
        const compoundTip = chk.ok
          ? (state.prefs.byPair && others > 0
            ? `Collect fees from all ${cg.positions.length} ${p.token0.symbol}/${p.token1.symbol} positions and add them to #${cg.target.id} (highest est. APR)`
            : state.prefs.byPair ? `Collect this position's fees and add them to #${cg.target.id}` : "Collect this position's fees and add them back into it")
          : chk.why;
        return `<div class="tr">
        <div class="td wide">
          <div class="pair">${esc(p.token0.symbol)} / ${esc(p.token1.symbol)}${targets.has(p.uid) ? '<span class="target-tag" title="Highest est. APR of this pair in this wallet: compounding goes here">TARGET</span>' : ''}</div>
          <div class="meta"><span class="chain-tag ${esc(p.chain)}">${esc(Y.chainOf(p.chain).native)}</span>${esc(p.dexLabel)} · ${feePct(p.feeTier)} · #${esc(p.id)}</div>
          ${compositionHtml(p)}
        </div>
        <div class="td span2" data-l="Wallet">${esc(walletName(p.owner))}</div>
        <div class="td end" data-l="Range"><span class="rng ${p.inRange ? 'in' : 'out'}">● ${p.inRange ? 'In range' : 'Out'}</span></div>
        <div class="td num" data-l="Value">${fmtUsd(p.value)}</div>
        <div class="td num" data-l="Est. APR" title="${esc(aprTip(p))}">${fmtPct(p.estApr)}</div>
        <div class="td num" data-l="Pool APR" title="Pool fees yesterday / pool TVL, annualised">${fmtPct(p.poolApr)}</div>
        <div class="td num" data-l="Net">${netCell(p)}</div>
        <div class="td num span2" data-l="Claimable">${claimCell(p)}</div>
        <div class="td wide"><div class="actions">
          <button class="btn small primary" type="button" data-act="compound" data-uid="${esc(p.uid)}" ${chk.ok && !busy ? '' : 'disabled'} title="${esc(compoundTip)}">Compound${state.prefs.byPair && others > 0 ? ` <span class="grp-n">×${others + 1}</span>` : ''}</button>
          <button class="btn small" type="button" data-act="collect" data-uid="${esc(p.uid)}" ${col.canCollect && !busy ? '' : 'disabled'} title="${esc(col.canCollect ? "Collect this position's fees to your wallet" : col.why)}">Collect</button>
          ${add ? `<button class="btn small add" type="button" data-act="add" data-uid="${esc(p.uid)}" ${busy ? 'disabled' : ''} title="${esc(addTip(add))}">Add</button>` : ''}
          <button class="btn small" type="button" data-act="send" data-uid="${esc(p.uid)}" ${isMine(p.owner) && !busy ? '' : 'disabled'} title="${isMine(p.owner) ? 'Send this position (its NFT) to another address' : 'Connect this wallet to send its positions'}">Send</button>
        </div></div>
        ${st ? `<div class="status ${st.kind || ''}">${st.html}</div>` : ''}
      </div>`;
      }).join('') || '<div class="empty">Nothing matches these filters.</div>'}</div>
      ${footer(rows)}
    </div>`;
  }

  /** A one-position group: the unit for Collect, and for Compound with by-pair off. */
  function soloGroup(p) {
    return {
      key: 'pos|' + p.uid, dex: p.dex, dexLabel: p.dexLabel, nfpm: p.nfpm, chain: p.chain, chainName: p.chainName,
      owner: p.owner, token0: p.token0, token1: p.token1, positions: [p], target: p,
      claimUsd: p.claimUsd, value: p.value, fee0: p.fee0, fee1: p.fee1, hasFeeError: !!p.feeError,
    };
  }
  const pairGroupOf = (p) => state.groups.find((g) => g.positions.some((q) => q.uid === p.uid));

  /**
   * The group a row's button acts on, with its status shown on that row.
   * Compound with "Compound by pair" on: every position of the pair (same
   * wallet and DEX) into the pair's best in-range position. Otherwise, and
   * always for Collect: just this position (compounding back into itself).
   */
  function actionGroup(p, mode) {
    const g = mode === 'compound' && state.prefs.byPair ? (pairGroupOf(p) || soloGroup(p)) : soloGroup(p);
    return { ...g, statusKey: p.uid };
  }

  /** What "Compound all shown" would run: one per pair with by-pair on, else one per row. */
  function compoundAllTargets(rows) {
    const out = [], seen = new Set();
    for (const p of rows) {
      const g = actionGroup(p, 'compound');
      if (seen.has(g.key) || !canCompound(g).ok) continue;
      seen.add(g.key);
      // With by-pair on, report on the target's row, which is what gets compounded into.
      out.push(state.prefs.byPair ? { ...g, statusKey: g.target.uid } : g);
    }
    return out;
  }

  function footer(rows) {
    const eligible = compoundAllTargets(rows);
    const f = state.prefs;
    return `<div class="foot">
      <span>${state.account ? `${eligible.length} ${f.byPair ? 'pair' : 'position'}${eligible.length === 1 ? '' : 's'} ready to compound from the connected wallet.` : 'Connect a wallet to collect or compound. Only positions owned by the connected wallet can be.'}
        Compound by pair ${f.byPair ? 'on' : 'off'} · slippage ${(f.slippageBps / 100).toFixed(2)}% · approvals ${f.approve === 'exact' ? 'exact amount' : 'unlimited'} · Collect pays out ${f.unwrapNative ? 'PLS / ETH' : 'WPLS / WETH'}.</span>
      <button class="btn small primary" type="button" data-act="compoundAll" ${eligible.length > 1 && !state.running ? '' : 'disabled'}>Compound all shown (${eligible.length})</button>
    </div>`;
  }

  function canCompound(g) {
    if (!state.account) return { ok: false, canCollect: false, why: 'Connect this wallet to compound' };
    if (g.owner !== state.account) return { ok: false, canCollect: false, why: 'Connect this wallet to compound' };
    if (g.hasFeeError) return { ok: false, canCollect: false, why: 'Fee read failed; refresh first' };
    if (!(g.fee0 > 0 || g.fee1 > 0)) return { ok: false, canCollect: false, why: 'Nothing to claim' };
    if (!g.target) return { ok: false, canCollect: true, why: 'No in-range position of this pair to compound into; turn off Compound by pair to compound a position into itself' };
    return { ok: true, canCollect: true };
  }

  // Smallest Add worth offering, in dollars: below that the gas costs more than goes in.
  const MIN_ADD_USD = 1;
  /**
   * Add: put the connected wallet's own tokens into a position, its own
   * button next to Compound whatever the fees (Gavin, 2026-10-31: offering it
   * only with nothing to claim meant it never showed, since any swap earns
   * fees). Offered when the wallet holds enough of the pair's tokens to fit
   * the range at the most recent price (native counts for a WPLS/WETH side,
   * above the reserve). Unclaimed fees stay where they are. With by-pair on it
   * goes into the pair's target, so only that row offers it; with it off each
   * position takes its own, out of range too (one token only). No swaps.
   * Returns what the most that fits would be, or null.
   */
  function addOffer(p) {
    const acct = state.account, f = state.funds;
    if (!acct || p.owner !== acct || !f || f.account !== acct) return null;
    const target = state.prefs.byPair ? actionGroup(p, 'compound').target : p;
    if (!target || target.uid !== p.uid) return null;
    const c = f.byChain[p.chain];
    if (!c) return null;
    const chain = Y.chainOf(p.chain);
    const wrappedIndex = p.token0.address === chain.wrapped ? 0 : p.token1.address === chain.wrapped ? 1 : -1;
    const plan = Y.topUpPlan({ sqrtPriceX96: p.sqrtPrice, tick: p.tick, tickLower: p.tickLower, tickUpper: p.tickUpper,
      fee0: 0n, fee1: 0n, wallet0: c.tokens[p.token0.address] || 0n, wallet1: c.tokens[p.token1.address] || 0n,
      native: wrappedIndex < 0 ? 0n : nativeSpare(c.native, c.price, COMPOUND_GAS, WRAP_GAS), wrappedIndex });
    const x = Y.topUpAt(plan, 1);
    if (x.n0 === 0n && x.n1 === 0n) return null;
    const a0 = Y.toUnits(x.n0, p.token0.decimals), a1 = Y.toUnits(x.n1, p.token1.decimals);
    // A token with no price can't be held to the minimum; it still needs some amount to fit.
    const priced = p.token0.usd > 0 && p.token1.usd > 0;
    const usd = a0 * p.token0.usd + a1 * p.token1.usd;
    if (priced && usd < MIN_ADD_USD) return null;
    return { target, a0, a1, usd: priced ? usd : null, wraps: x.wrap > 0n };
  }

  function addTip(a) {
    const p = a.target, nat = Y.chainOf(p.chain).native;
    return `Add up to ${fmtAmt(a.a0)} ${p.token0.symbol} + ${fmtAmt(a.a1)} ${p.token1.symbol}`
      + `${a.usd == null ? '' : ` (${fmtUsd(a.usd)})`} from your wallet to #${p.id}`
      + `${a.wraps ? `, wrapping some ${nat} for the W${nat} side` : ''}. You choose how much on the next screen; nothing is swapped.`;
  }

  // ---------- wallet connection (EIP-6963, with window.ethereum fallback) ----------
  window.addEventListener('eip6963:announceProvider', (e) => {
    const d = e.detail;
    if (!d || !d.provider || !d.info) return;
    if (state.providers.some((p) => p.info.uuid === d.info.uuid)) return;
    state.providers.push(d);
    renderConnect();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  function availableProviders() {
    if (state.providers.length) return state.providers;
    if (window.ethereum) return [{ info: { name: 'Browser wallet', rdns: 'injected', icon: '' }, provider: window.ethereum }];
    return [];
  }

  function renderConnect() {
    const el = $('connectArea');
    if (state.account) {
      const onChain = Object.values(Y.CHAINS).find((c) => c.id === state.chainId);
      const wrong = !onChain;
      const tracked = walletIndex(state.account) >= 0;
      // Network switcher: every chain the page supports, current one ticked.
      // Compounding still switches per pair on its own; this is for doing it
      // by hand (and for getting off an unsupported network).
      const netLabel = state.switching ? 'Switching…' : onChain ? esc(onChain.name) : 'Unsupported network';
      const netMenu = state.netMenuOpen ? `<div class="picker-menu net-menu" role="menu">${Object.values(Y.CHAINS).map((c) => {
        const here = c.id === state.chainId;
        return `<button type="button" role="menuitemradio" aria-checked="${here}" data-act="pickNet" data-chain="${esc(c.key)}">
          <span class="chain-dot ${esc(c.key)}"></span>${esc(c.name)}${here ? '<span class="check">✓</span>' : ''}</button>`;
      }).join('')}</div>` : '';
      el.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:center">
        ${tracked ? '' : '<button class="btn small" type="button" data-act="trackMe">Track this wallet</button>'}
        <div class="net-switch">
          <button class="btn net-btn${wrong ? ' warn' : ''}" type="button" data-act="netMenu" aria-haspopup="menu" aria-expanded="${state.netMenuOpen}"
            title="Switch your wallet's network" ${state.switching ? 'disabled' : ''}>
            <span class="chain-dot ${onChain ? esc(onChain.key) : 'none'}"></span>${netLabel}<span class="caret">▾</span>
          </button>${netMenu}
        </div>
        <button class="btn acct${wrong ? ' wrong' : ''}" type="button" data-act="disconnect" title="Disconnect">
          <span class="dot"></span><span class="mono">${state.prefs.mask ? 'Connected' : shortAddr(state.account)}</span><span style="color:var(--dimmer)">×</span>
        </button></div>`;
      return;
    }
    const list = availableProviders();
    el.innerHTML = `<button class="btn primary" type="button" data-act="connect">Connect wallet</button>
      ${state.pickerOpen ? `<div class="picker-menu" id="pickerMenu"></div>` : ''}`;
    if (state.pickerOpen) {
      const menu = $('pickerMenu');
      if (!list.length) {
        menu.innerHTML = `<div class="meta" style="padding:8px;white-space:normal">No browser wallet found. Install a wallet extension such as Rabby or MetaMask, or open this page in your wallet app's browser.</div>`;
      }
      list.forEach((p, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.act = 'pick';
        b.dataset.i = String(i);
        if (p.info.icon) { const img = document.createElement('img'); img.src = p.info.icon; img.alt = ''; img.onerror = () => img.remove(); b.appendChild(img); }
        b.appendChild(document.createTextNode(p.info.name || 'Wallet'));
        menu.appendChild(b);
      });
    }
  }

  function attach(p) {
    const prov = p.provider;
    state.provider = prov;
    if (prov.on) {
      prov.on('accountsChanged', (accs) => { state.account = accs && accs[0] ? accs[0].toLowerCase() : null; state.funds = null; render(); loadFunds(); });
      prov.on('chainChanged', (id) => { state.chainId = parseInt(id, 16); render(); });
    }
  }

  async function connect(p) {
    try {
      attach(p);
      const accs = await p.provider.request({ method: 'eth_requestAccounts' });
      state.account = accs && accs[0] ? accs[0].toLowerCase() : null;
      state.chainId = parseInt(await p.provider.request({ method: 'eth_chainId' }), 16);
      store.set(K.rdns, p.info.rdns || 'injected');
      state.pickerOpen = false;
      loadFunds();
    } catch (e) {
      showError('Wallet connection failed: ' + (e.message || e));
    }
    render();
  }

  /** Reconnect without a prompt if this site was already authorised last time. */
  async function silentReconnect() {
    const rdns = store.get(K.rdns, null);
    if (!rdns) return;
    const p = availableProviders().find((x) => (x.info.rdns || 'injected') === rdns);
    if (!p) return;
    try {
      const accs = await p.provider.request({ method: 'eth_accounts' });
      if (!accs || !accs[0]) return;
      attach(p);
      state.account = accs[0].toLowerCase();
      state.chainId = parseInt(await p.provider.request({ method: 'eth_chainId' }), 16);
      render();
      loadFunds();
    } catch (_) { /* stay disconnected */ }
  }

  /** Ask the wallet to move to a supported chain, adding PulseChain if it lacks it. */
  async function switchChain(key = 'pulsechain') {
    const prov = state.provider;
    const chain = Y.chainOf(key);
    try {
      await prov.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chain.hex }] });
    } catch (e) {
      const missing = e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902));
      if (missing && chain.addChain) {
        await prov.request({ method: 'wallet_addEthereumChain', params: [{ chainId: chain.hex, ...chain.addChain }] });
      } else throw e;
    }
    state.chainId = parseInt(await prov.request({ method: 'eth_chainId' }), 16);
    if (state.chainId !== chain.id) throw new Error('Wallet is not on ' + chain.name);
  }

  function disconnect() {
    const prov = state.provider;
    if (prov && prov.request) prov.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {});
    state.account = null; state.chainId = null; state.provider = null; state.funds = null;
    store.del(K.rdns);
    render();
  }

  // ---------- transactions ----------
  function setStatus(key, html, kind) { state.status[key] = { html, kind }; renderList(); }
  const txLink = (h, chainKey) => `<a href="${Y.chainOf(chainKey).explorerTx}${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}…</a>`;

  async function waitReceipt(hash, rpcs) {
    for (let i = 0; i < 240; i++) {
      try {
        const rc = await Y.rpcCall('eth_getTransactionReceipt', [hash], rpcs);
        if (rc) return rc;
      } catch (_) { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error('Timed out waiting for the transaction. Check it on the explorer.');
  }

  async function sendTx(data, to, value = 0n) {
    const acct = state.account;
    const hash = await state.provider.request({ method: 'eth_sendTransaction', params: [{ from: acct, to, data, value: '0x' + value.toString(16) }] });
    return hash;
  }

  // Gas units a compound is costed at when there's no estimate of the real
  // one yet (approvals, collect). Measured on a fork 2026-09-29: 209k for 2
  // positions, 422k for 3, 504k for a single INC/PLSX position.
  const COMPOUND_GAS = 500000n;
  /**
   * Native kept back after every transaction: twice what a compound costs on
   * this chain right now, so the wallet can always pay for the next two
   * (Gavin, 2026-09-29; it replaced a flat 1,000 PLS).
   */
  const reserveWei = (price, compoundGas) => 2n * (compoundGas || COMPOUND_GAS) * price;
  // Gas a wrap (deposit()) is costed at when it can't be estimated.
  const WRAP_GAS = 50000n;
  /**
   * Native a top-up or an Add may wrap: the balance above the reserve, the
   * compound or add's own gas and the wrap's, both at twice the gas price.
   */
  const nativeSpare = (bal, price, compoundGas, wrapGas) => {
    const keep = reserveWei(price, compoundGas) + 2n * compoundGas * price + 2n * wrapGas * price;
    return bal > keep ? bal - keep : 0n;
  };

  /**
   * Refuse a transaction that would leave the wallet below the native reserve
   * after gas and `value`. Gas is the estimate at twice the current price,
   * since the base fee can climb before the wallet signs. Returns the balance
   * and cost for the confirm screen.
   */
  async function checkNativeReserve(chainKey, to, data, { value = 0n, compoundGas = null } = {}) {
    const chain = Y.chainOf(chainKey);
    const [bal, gas, price] = await Promise.all([
      Y.rpcCall('eth_getBalance', [state.account, 'latest'], chain.rpcs),
      Y.rpcCall('eth_estimateGas', [{ from: state.account, to, data, value: '0x' + value.toString(16) }], chain.rpcs),
      Y.rpcCall('eth_gasPrice', [], chain.rpcs),
    ]);
    const reserve = reserveWei(BigInt(price), compoundGas);
    const balance = BigInt(bal), cost = BigInt(gas) * BigInt(price) * 2n;
    const after = balance - cost - value;
    if (after < reserve) {
      const f = (w) => fmtAmt(Number(w) / 1e18);
      throw new Error(`Needs up to ${f(cost + value)} ${chain.native}${value ? ' (gas and the amount wrapped)' : ' for gas'} and the wallet has ${f(balance)} ${chain.native}; `
        + `at least ${f(reserve)} ${chain.native} (twice the cost of a compound) must stay in the wallet. Add ${chain.native} and try again.`);
    }
    return { balance, cost, after, reserve };
  }

  async function ensureAllowance(g, token, need, label) {
    if (need === 0n) return;
    const acct = state.account;
    const rpcs = Y.chainOf(g.chain).rpcs;
    const have = await Y.readAllowance(token.address, acct, g.nfpm, rpcs);
    if (have >= need) return;
    const amount = state.prefs.approve === 'unlimited' ? Y.MAX256 : need;
    const approveData = Y.SEL.approve + Y.addrWord(g.nfpm) + Y.word(amount);
    await checkNativeReserve(g.chain, token.address, approveData);
    setStatus(g.statusKey || g.key, `${label}: approve ${esc(token.symbol)} in your wallet…`);
    const hash = await sendTx(approveData, token.address);
    setStatus(g.statusKey || g.key, `${label}: approving ${esc(token.symbol)} ${txLink(hash, g.chain)}…`);
    const rc = await waitReceipt(hash, rpcs);
    if (rc.status !== '0x1') throw new Error(token.symbol + ' approval failed');
  }

  async function gasQuote(to, data, chainKey) {
    const chain = Y.chainOf(chainKey);
    try {
      const [gas, price] = await Promise.all([
        Y.rpcCall('eth_estimateGas', [{ from: state.account, to, data }], chain.rpcs),
        Y.rpcCall('eth_gasPrice', [], chain.rpcs),
      ]);
      const native = (Number(BigInt(gas)) * Number(BigInt(price))) / 1e18;
      return { native, symbol: chain.native, usd: native * (state.nativeUsd[chain.key] || 0), units: BigInt(gas), price: BigInt(price) };
    } catch (_) { return null; }
  }

  /**
   * Compound (or just collect) one pair group.
   *   1. Re-read fees from chain, from the connected wallet.
   *   2. Approve the position manager for the fee amounts if needed.
   *   3. Simulate collect-all + increaseLiquidity to learn what actually fits
   *      the target's range, then set minimums from that less slippage.
   *   4. Confirm on the page, then in the wallet; wait for the receipt.
   * Everything goes to the owner's own wallet; the page never holds funds.
   */
  /**
   * Collect-as-native plan for a pair, or null when the pair has no wrapped
   * native side (WPLS/WETH) or the option is off. `f0`/`f1` are the fees
   * just read, used as the unwrap/sweep minimums.
   */
  function unwrapPlan(g, f0, f1, on) {
    const wrapped = Y.chainOf(g.chain).wrapped;
    if (!on || !wrapped) return null;
    if (g.token0.address === wrapped) return { dex: g.dex, other: g.token1.address, minWrapped: f0, minOther: f1 };
    if (g.token1.address === wrapped) return { dex: g.dex, other: g.token0.address, minWrapped: f1, minOther: f0 };
    return null;
  }
  const hasWrappedSide = (g) => !!unwrapPlan(g, 0n, 0n, true);

  /**
   * What the wallet could add on top of the fees: its balances of both tokens
   * and, for a WPLS/WETH side, native above the reserve (after the compound
   * and the wrap, both at twice the gas price). Null when it can't be read.
   */
  async function topUpContext(g, f0, f1, gas) {
    const chain = Y.chainOf(g.chain), rpcs = chain.rpcs, acct = state.account, t = g.target;
    const wrappedIndex = g.token0.address === chain.wrapped ? 0 : g.token1.address === chain.wrapped ? 1 : -1;
    const bal = (tok) => Y.ethCall(tok, Y.SEL.balanceOf + Y.addrWord(acct), null, rpcs).then((h) => Y.wordsOf(h)[0]);
    const [ps, w0, w1, nativeHex, priceHex, wrapGasHex] = await Promise.all([
      Y.ethCall(t.poolId, Y.SEL[Y.DEXES[g.dex].poolState || 'slot0'], null, rpcs),
      bal(g.token0.address), bal(g.token1.address),
      Y.rpcCall('eth_getBalance', [acct, 'latest'], rpcs),
      Y.rpcCall('eth_gasPrice', [], rpcs),
      wrappedIndex < 0 ? '0x0' : Y.rpcCall('eth_estimateGas', [{ from: acct, to: chain.wrapped, data: Y.SEL.deposit, value: '0x1' }], rpcs).catch(() => '0x' + WRAP_GAS.toString(16)),
    ]);
    const w = Y.wordsOf(ps), price = BigInt(priceHex), compoundGas = gas && gas.units ? gas.units : COMPOUND_GAS;
    const nativeBal = BigInt(nativeHex);
    const native = wrappedIndex < 0 ? 0n : nativeSpare(nativeBal, price, compoundGas, BigInt(wrapGasHex));
    const plan = Y.topUpPlan({ sqrtPriceX96: w[0].toString(), tick: Number(BigInt.asIntN(24, w[1])), tickLower: t.tickLower, tickUpper: t.tickUpper,
      fee0: f0, fee1: f1, wallet0: w0, wallet1: w1, native, wrappedIndex });
    return { ...plan, compoundGas, nativeBal, price, reserve: reserveWei(price, compoundGas), wrapCost: 2n * BigInt(wrapGasHex) * price };
  }

  async function runGroup(g, mode, opts = {}) {
    const label = `${esc(g.token0.symbol)}/${esc(g.token1.symbol)}`;
    const acct = state.account;
    try {
      if (!acct || g.owner !== acct) throw new Error('Connect the wallet that owns these positions');
      const chain = Y.chainOf(g.chain), rpcs = chain.rpcs;
      if (state.chainId !== chain.id) {
        setStatus(g.statusKey || g.key, `Switch your wallet to ${esc(chain.name)}…`);
        await switchChain(g.chain);
        renderConnect();
      }

      setStatus(g.statusKey || g.key, 'Reading fees from chain…');
      const ids = g.positions.map((p) => p.id);
      const fees = await Y.fetchFees(ids.map((id) => ({ id, owner: acct, nfpm: g.nfpm, chain: g.chain })));
      const bad = fees.find((f) => f.error);
      if (bad) throw new Error('Fee read failed: ' + bad.error);
      const f0 = fees.reduce((s, f) => s + f.fee0, 0n);
      const f1 = fees.reduce((s, f) => s + f.fee1, 0n);
      if (f0 === 0n && f1 === 0n) { setStatus(g.statusKey || g.key, 'Nothing to claim right now.', 'ok'); return true; }
      const d0 = g.token0.decimals, d1 = g.token1.decimals;
      const u0 = Y.toUnits(f0, d0), u1 = Y.toUnits(f1, d1);
      const claimUsd = u0 * g.token0.usd + u1 * g.token1.usd;

      let data, summary;
      if (mode === 'compound') {
        // Before any approval: can the wallet pay for a compound at all (its
        // gas at twice the price, plus the reserve of two more)? Otherwise an
        // approval goes through and the compound is refused after it.
        const [balHex, priceHex] = await Promise.all([Y.rpcCall('eth_getBalance', [acct, 'latest'], rpcs), Y.rpcCall('eth_gasPrice', [], rpcs)]);
        const need = 4n * COMPOUND_GAS * BigInt(priceHex);
        if (BigInt(balHex) < need) {
          const f = (w) => fmtAmt(Number(w) / 1e18);
          throw new Error(`A compound needs about ${f(need / 2n)} ${chain.native} for gas and at least as much again must stay in the wallet (${f(need)} ${chain.native} in all); `
            + `the wallet has ${f(BigInt(balHex))} ${chain.native}. Add ${chain.native} and try again.`);
        }
        const t = g.target;
        const onchain = await Y.readPosition(g.nfpm, t.id, rpcs);
        if (onchain.token0 !== g.token0.address || onchain.token1 !== g.token1.address) throw new Error('Target position does not match this pair');
        await ensureAllowance(g, g.token0, f0, label);
        await ensureAllowance(g, g.token1, f1, label);

        setStatus(g.statusKey || g.key, 'Simulating…');
        const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
        const sim = await Y.ethCall(g.nfpm, Y.buildCompoundData({ ids, owner: acct, targetId: t.id, amount0: f0, amount1: f1, deadline }), acct, rpcs);
        const r = Y.decodeIncreaseResult(sim);
        const bps = state.prefs.slippageBps;
        data = Y.buildCompoundData({ ids, owner: acct, targetId: t.id, amount0: f0, amount1: f1,
          min0: Y.withSlippage(r.used0, bps), min1: Y.withSlippage(r.used1, bps), deadline });
        const used0 = Y.toUnits(r.used0, d0), used1 = Y.toUnits(r.used1, d1);
        const usedUsd = used0 * g.token0.usd + used1 * g.token1.usd;
        // From the exact integers: float subtraction left crumbs like
        // "0.000000000000000187 PAXG" on the confirm screen.
        const left0 = Y.toUnits(f0 - r.used0, d0), left1 = Y.toUnits(f1 - r.used1, d1);
        summary = { t, used0, used1, usedUsd, left0, left1, leftUsd: Math.max(0, claimUsd - usedUsd) };
      } else {
        data = Y.buildCollectData({ ids, owner: acct, nfpm: g.nfpm, unwrap: unwrapPlan(g, f0, f1, state.prefs.unwrapNative) });
      }

      // Final dry run of the exact bytes the wallet will sign.
      await Y.ethCall(g.nfpm, data, acct, rpcs);
      const gas = await gasQuote(g.nfpm, data, g.chain);
      const native = await checkNativeReserve(g.chain, g.nfpm, data, { compoundGas: mode === 'compound' && gas ? gas.units : null });

      let unwrapped = mode === 'collect' && !!unwrapPlan(g, f0, f1, state.prefs.unwrapNative);
      let fromWalletUsd = 0;
      if (!opts.skipConfirm) {
        // Compound all stays fees-only: only a single compound offers the top-up.
        const topUp = mode === 'compound' ? await topUpContext(g, f0, f1, gas).catch(() => null) : null;
        const res = await confirmModal(g, mode, { u0, u1, claimUsd, summary, gas, native, count: ids.length, topUp });
        if (!res.ok) { delete state.status[g.statusKey || g.key]; renderList(); return false; }
        if (mode === 'compound' && topUp && res.topUp > 0) {
          const x = Y.topUpAt(topUp, res.topUp);
          const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
          if (x.wrap > 0n) {
            // The position manager pays a side all in native or all in the
            // wrapped token, never a mix, so native is wrapped first.
            const wrapped = Y.chainOf(g.chain).wrapped;
            await checkNativeReserve(g.chain, wrapped, Y.SEL.deposit, { value: x.wrap, compoundGas: topUp.compoundGas });
            setStatus(g.statusKey || g.key, `${label}: wrap ${fmtAmt(Number(x.wrap) / 1e18)} ${esc(chain.native)} in your wallet…`);
            const wh = await sendTx(Y.SEL.deposit, wrapped, x.wrap);
            setStatus(g.statusKey || g.key, `${label}: wrapping ${txLink(wh, g.chain)}…`);
            const wrc = await waitReceipt(wh, rpcs);
            if (wrc.status !== '0x1') throw new Error('Wrapping ' + chain.native + ' failed');
          }
          await ensureAllowance(g, g.token0, x.n0, label);
          await ensureAllowance(g, g.token1, x.n1, label);
          setStatus(g.statusKey || g.key, 'Simulating with the top-up…');
          const t = g.target;
          const sim2 = await Y.ethCall(g.nfpm, Y.buildCompoundData({ ids, owner: acct, targetId: t.id, amount0: x.n0, amount1: x.n1, deadline }), acct, rpcs);
          const r2 = Y.decodeIncreaseResult(sim2);
          const bps = state.prefs.slippageBps;
          data = Y.buildCompoundData({ ids, owner: acct, targetId: t.id, amount0: x.n0, amount1: x.n1,
            min0: Y.withSlippage(r2.used0, bps), min1: Y.withSlippage(r2.used1, bps), deadline });
          await Y.ethCall(g.nfpm, data, acct, rpcs);
          const used0 = Y.toUnits(r2.used0, d0), used1 = Y.toUnits(r2.used1, d1);
          summary.usedUsd = used0 * g.token0.usd + used1 * g.token1.usd;
          // Per token, what went in beyond its fees: the confirm panel's split.
          fromWalletUsd = Math.max(0, used0 - u0) * g.token0.usd + Math.max(0, used1 - u1) * g.token1.usd;
          summary.leftUsd = Math.max(0, claimUsd - summary.usedUsd);
        }
        // The checkbox on the confirm screen changes the transaction itself:
        // rebuild it and re-run the same dry run and reserve check.
        if (mode === 'collect' && hasWrappedSide(g) && res.unwrap !== state.prefs.unwrapNative) {
          state.prefs.unwrapNative = res.unwrap; savePrefs();
          data = Y.buildCollectData({ ids, owner: acct, nfpm: g.nfpm, unwrap: unwrapPlan(g, f0, f1, res.unwrap) });
          await Y.ethCall(g.nfpm, data, acct, rpcs);
          await checkNativeReserve(g.chain, g.nfpm, data);
          unwrapped = res.unwrap;
        }
      }

      // The wallet may have been moved off this chain while the modal was open.
      if (state.chainId !== chain.id) await switchChain(g.chain);
      // Re-check just before signing. Fees-only (the default, and always for
      // Compound all): the add is capped at the fees read above and the same
      // tx collects at least that much first, so the wallet's own tokens are
      // never drawn on. That only holds if nothing collected these fees since,
      // e.g. another tab. With a top-up the user chose the wallet amounts.
      if (mode === 'compound') {
        const now = await Y.fetchFees(ids.map((id) => ({ id, owner: acct, nfpm: g.nfpm, chain: g.chain })));
        if (now.some((f) => f.error)) throw new Error('Fee re-check failed; nothing was sent. Refresh and try again.');
        const n0 = now.reduce((s, f) => s + f.fee0, 0n), n1 = now.reduce((s, f) => s + f.fee1, 0n);
        if (n0 < f0 || n1 < f1) throw new Error('These fees were collected elsewhere since you confirmed; nothing was sent. Refresh and try again.');
      }
      await checkNativeReserve(g.chain, g.nfpm, data, { compoundGas: mode === 'compound' && gas ? gas.units : null });
      if (fromWalletUsd > 0) await Y.ethCall(g.nfpm, data, acct, rpcs); // the wallet's tokens are still there
      setStatus(g.statusKey || g.key, 'Confirm in your wallet…');
      const hash = await sendTx(data, g.nfpm);
      setStatus(g.statusKey || g.key, `Pending ${txLink(hash, g.chain)}…`);
      const rc = await waitReceipt(hash, rpcs);
      if (rc.status !== '0x1') throw new Error('Transaction reverted ' + hash);
      setStatus(g.statusKey || g.key, mode === 'compound'
        ? `Compounded ${fmtUsd(summary.usedUsd)} into #${esc(summary.t.id)}${fromWalletUsd >= 0.01 ? ` (${fmtUsd(fromWalletUsd)} from your wallet)` : ''} ${txLink(hash, g.chain)}${summary.leftUsd >= 0.01 ? ` · ${fmtUsd(summary.leftUsd)} left in wallet` : ''}`
        : `Collected ${fmtUsd(claimUsd)} to your wallet${unwrapped ? ` (W${esc(chain.native)} as ${esc(chain.native)})` : ''} ${txLink(hash, g.chain)}`, 'ok');
      return true;
    } catch (e) {
      const msg = e && e.code === 4001 ? 'Rejected in wallet.' : (e.message || String(e));
      setStatus(g.statusKey || g.key, esc(msg) + (mode === 'compound' && /reverted/i.test(msg) ? ' If only one token has fees, try Collect.' : ''), 'bad');
      return false;
    }
  }

  function confirmModal(g, mode, d) {
    const s = d.summary;
    const sym0 = esc(g.token0.symbol), sym1 = esc(g.token1.symbol);
    const rows = [
      ['From', `${d.count} position${d.count === 1 ? '' : 's'} · ${esc(walletName(g.owner))}`],
      ['Claimable', `${fmtAmt(d.u0)} ${sym0} + ${fmtAmt(d.u1)} ${sym1}<br><span style="color:var(--gold)">${fmtUsd(d.claimUsd)}</span>`],
    ];
    if (mode === 'compound') {
      rows.push(['Adds to', `#${esc(s.t.id)} · ${feePct(s.t.feeTier)}${s.t.estApr == null ? '' : ` · est. ${fmtPct(s.t.estApr)} APR`}`]);
      rows.push(['Fees left in wallet', `<span id="mLeft">${fmtAmt(Math.max(0, s.left0))} ${sym0} + ${fmtAmt(Math.max(0, s.left1))} ${sym1}<br>${fmtUsd(s.leftUsd)}</span>`]);
    }
    rows.push(['Network', esc(g.chainName)]);
    rows.push(['Network fee', d.gas ? `≈ ${fmtAmt(d.gas.native)} ${esc(d.gas.symbol)}${d.gas.usd ? ` (${fmtUsd(d.gas.usd)})` : ''}` : 'Your wallet will show it']);
    if (d.native) {
      const chain = Y.chainOf(g.chain);
      rows.push([`${esc(chain.native)} left after gas`, `≥ <span id="mNative">${fmtAmt(Number(d.native.after) / 1e18)}</span> ${esc(chain.native)}`
        + (d.native.reserve > 0n ? `<br><span style="color:var(--dim)">keeps at least ${fmtAmt(Number(d.native.reserve) / 1e18)}</span>` : '')]);
    }
    const leftShare = mode === 'compound' && d.claimUsd > 0 ? s.leftUsd / d.claimUsd : 0;
    const tu = mode === 'compound' ? d.topUp : null;
    const canTopUp = !!tu && tu.lMax > tu.lFees * 1.001;
    const nat = esc(Y.chainOf(g.chain).native);
    const units = (raw, dec) => Number(raw) / 10 ** dec;
    const usd0 = g.token0.usd || 0, usd1 = g.token1.usd || 0;
    /**
     * The panel at the top: everything going into the position, per token and
     * in total, split between the fees and the wallet. Amounts are token units;
     * w0/w1 include native wrapped for that side (`wrap`, raw wei).
     */
    const deposit = ({ a0, a1, f0, f1, w0, w1, wrap = 0n, approx }) => {
      const feesUsd = f0 * usd0 + f1 * usd1, walletUsd = w0 * usd0 + w1 * usd1, total = feesUsd + walletUsd;
      const fromWallet = w0 > 0 || w1 > 0;
      const from = (f, w, sym) => (!(f > 0 || w > 0) ? 'none at this range'
        : !(w > 0) ? 'all from fees'
          : `${fmtAmt(f)} from fees<br><span class="w">+ ${fmtAmt(w)} ${sym} from your wallet</span>`);
      const fp = total > 0 ? Math.round((feesUsd / total) * 100) : 100;
      return { wallet: fromWallet, html: `
        <div class="dep-h"><span>Going into #${esc(s.t.id)}</span>${fromWallet ? `<span class="dep-badge">+ ${fmtUsd(walletUsd)} from your wallet</span>` : ''}</div>
        <div class="dep-total">${approx ? '≈ ' : ''}${fmtUsd(total)}</div>
        <div class="dep-sub">${fromWallet
          ? `<b>${fmtUsd(feesUsd)}</b> of fees + <b class="w">${fmtUsd(walletUsd)}</b> from your wallet`
          : 'All of it fees: nothing comes out of your wallet'}${usd0 > 0 && usd1 > 0 ? '' : ' · a token has no price, so the $ total leaves it out'}</div>
        <div class="dep-tok"><span class="dep-amt">${fmtAmt(a0)}<span class="sym">${sym0}</span></span><span class="dep-from">${from(f0, w0, sym0)}</span></div>
        <div class="dep-tok"><span class="dep-amt">${fmtAmt(a1)}<span class="sym">${sym1}</span></span><span class="dep-from">${from(f1, w1, sym1)}</span></div>
        ${wrap > 0n ? `<div class="dep-from" style="text-align:left;margin-top:6px"><span class="w">Includes ${fmtAmt(Number(wrap) / 1e18)} ${nat} from your wallet, wrapped to W${nat} first</span></div>` : ''}
        ${fromWallet && total > 0 ? `<div class="dep-bar" aria-hidden="true"><span class="f" style="width:${fp}%"></span><span class="w" style="width:${100 - fp}%"></span></div>
          <div class="dep-legend"><span>Fees ${fp}%</span><span>Your wallet ${100 - fp}%</span></div>` : ''}` };
    };
    // Fees only, from the simulation: what the button sends as things stand.
    const dep0 = mode === 'compound' ? deposit({ a0: s.used0, a1: s.used1, f0: s.used0, f1: s.used1, w0: 0, w1: 0, approx: false }) : null;
    // The preview at slider position t (0..1); the simulation after Confirm sets the real amounts.
    const preview = (t) => {
      const x = Y.topUpAt(tu, t);
      const d0 = g.token0.decimals, d1 = g.token1.decimals;
      const l0 = units(tu.fee0 - x.s0.fromFees, d0), l1 = units(tu.fee1 - x.s1.fromFees, d1);
      return {
        dep: deposit({ a0: units(x.n0, d0), a1: units(x.n1, d1), f0: units(x.s0.fromFees, d0), f1: units(x.s1.fromFees, d1),
          w0: units(x.s0.fromWallet + x.s0.fromNative, d0), w1: units(x.s1.fromWallet + x.s1.fromNative, d1), wrap: x.wrap, approx: true }),
        left: `${fmtAmt(Math.max(0, l0))} ${sym0} + ${fmtAmt(Math.max(0, l1))} ${sym1}<br>${fmtUsd(Math.max(0, l0) * usd0 + Math.max(0, l1) * usd1)}`,
        wraps: x.wrap > 0n,
        // Wrapping spends native twice over: the amount, and the wrap's own gas.
        nativeAfter: d.native ? Number(d.native.after - (x.wrap > 0n ? x.wrap + tu.wrapCost : 0n)) / 1e18 : null,
      };
    };
    const slider = !canTopUp ? (tu ? `<p class="note">Your wallet has nothing more that fits this range, so only the fees go in.</p>` : '') : `
      <div class="topup">
        <div class="topup-h"><span>Add from your wallet too</span><span id="mPct">Fees only</span></div>
        <input type="range" id="mTop" min="0" max="1000" step="1" value="0" aria-label="How much to add from your wallet">
        <div class="topup-ends"><span>Fees only</span><span>Most that fits</span></div>
      </div>`;
    const gasHeavy = d.gas && d.gas.usd && d.gas.usd > d.claimUsd * 0.2;
    return new Promise((resolve) => {
      const root = $('modalRoot');
      root.innerHTML = `<div class="modal-bg" id="mbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mh">
        <h2 id="mh">${mode === 'compound' ? 'Compound' : 'Collect'} ${sym0} / ${sym1}</h2>
        ${dep0 ? `<div class="dep" id="mDep" aria-live="polite">${dep0.html}</div>` : ''}
        ${slider}
        ${rows.map(([k, v]) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
        ${mode === 'collect' && hasWrappedSide(g) ? `<label class="modal-toggle"><input type="checkbox" id="mUnwrap"${state.prefs.unwrapNative ? ' checked' : ''}>
          Receive W${esc(Y.chainOf(g.chain).native)} as ${esc(Y.chainOf(g.chain).native)}</label>` : ''}
        ${mode === 'compound' ? `<p class="note">One transaction collects the fees to your wallet and adds what fits the target's range. ${canTopUp ? `By default only the fees go in. Move the slider to add ${sym0} and ${sym1} from your wallet as well, up to what fits the range at today's price${tu.wrappedIndex >= 0 ? `, including ${nat} (wrapped to W${nat} in a separate transaction first)` : ''}. At least ${fmtAmt(Number(tu.reserve) / 1e18)} ${nat}, twice the cost of this compound, always stays in the wallet.` : `Only these fees are added; tokens already in your wallet are not used.`} Fees that don't fit stay in your wallet${leftShare > 0.25 ? `. <span id="mLop" style="color:var(--warn)">The fees are lopsided for this range, so a large share is left over${canTopUp ? '; the slider can use it up' : ''}.</span>` : '.'} Minimums are set ${(state.prefs.slippageBps / 100).toFixed(2)}% under the simulation.</p>` : `<p class="note">Fees go to your wallet; nothing is re-added.${hasWrappedSide(g) ? ` With the box ticked, the W${esc(Y.chainOf(g.chain).native)} arrives unwrapped as ${esc(Y.chainOf(g.chain).native)} in the same transaction; the other token is unchanged.` : ''}</p>`}
        ${gasHeavy ? '<p class="note warn">The network fee is more than a fifth of what you are claiming.</p>' : ''}
        <div class="modal-actions"><button class="btn" type="button" id="mNo">Cancel</button><button class="btn primary" type="button" id="mYes">Confirm in wallet</button></div>
      </div></div>`;
      const done = (ok) => {
        const box = $('mUnwrap');
        const unwrap = box ? box.checked : state.prefs.unwrapNative;
        const range = $('mTop');
        const topUp = range ? Number(range.value) / 1000 : 0;
        root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve({ ok, unwrap, topUp });
      };
      const range = $('mTop');
      if (range) {
        const fresh = { left: $('mLeft').innerHTML, native: $('mNative') ? $('mNative').textContent : '' };
        const showDep = (dep) => { $('mDep').innerHTML = dep.html; $('mDep').classList.toggle('wallet', dep.wallet); };
        range.addEventListener('input', () => {
          const t = Number(range.value) / 1000;
          if (t === 0) {
            showDep(dep0); $('mLeft').innerHTML = fresh.left;
            if ($('mNative')) $('mNative').textContent = fresh.native;
            if ($('mLop')) $('mLop').hidden = false;
            $('mPct').textContent = 'Fees only'; $('mYes').textContent = 'Confirm in wallet';
            return;
          }
          const v = preview(t);
          showDep(v.dep); $('mLeft').innerHTML = v.left;
          if ($('mNative') && v.nativeAfter != null) $('mNative').textContent = fmtAmt(v.nativeAfter);
          if ($('mLop')) $('mLop').hidden = true;
          $('mPct').textContent = t === 1 ? 'Most that fits' : Math.round(t * 100) + '%';
          $('mYes').textContent = v.wraps ? 'Wrap, then confirm in wallet' : 'Confirm in wallet';
        });
      }
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      document.addEventListener('keydown', onKey);
      $('mNo').onclick = () => done(false);
      $('mYes').onclick = () => done(true);
      $('mbg').onclick = (e) => { if (e.target.id === 'mbg') done(false); };
      $('mYes').focus();
    });
  }

  async function compoundAll() {
    const rows = compoundAllTargets(state.positions.filter(passes).sort(sorter('position')));
    if (!rows.length) return;
    const total = rows.reduce((s, g) => s + g.claimUsd, 0);
    const unit = state.prefs.byPair ? 'pair' : 'position';
    const ok = await simpleConfirm(`Compound ${rows.length} ${unit}s`,
      `About ${fmtUsd(total)} of fees across ${rows.length} ${unit}s. Each ${unit} is its own transaction, so your wallet will ask ${rows.length} times (plus any approvals). You can reject any one to skip it.`);
    if (!ok) return;
    state.running = true; renderList();
    for (const g of rows) await runGroup(g, 'compound', { skipConfirm: true });
    state.running = false;
    await refresh();
  }

  // ---------- add the wallet's own tokens to a position ----------
  /**
   * Add (see addOffer for where it's offered). No fees are involved:
   *   1. Check the connected wallet still holds the position and can pay for
   *      gas with the reserve left, before any approval.
   *   2. Read balances and the pool price; the confirm screen picks how much.
   *   3. Wrap native for a WPLS/WETH side if needed, approve, simulate, and
   *      set minimums from the simulation less slippage.
   *   4. Final dry run and reserve check, then the wallet signs.
   */
  async function runAdd(p) {
    const a = addOffer(p);
    if (!a) return false;
    const t = a.target, g = { ...soloGroup(t), statusKey: p.uid }, key = g.statusKey;
    const label = `${esc(g.token0.symbol)}/${esc(g.token1.symbol)}`, acct = state.account;
    try {
      const chain = Y.chainOf(g.chain), rpcs = chain.rpcs;
      if (state.chainId !== chain.id) {
        setStatus(key, `Switch your wallet to ${esc(chain.name)}…`);
        await switchChain(g.chain);
        renderConnect();
      }
      setStatus(key, 'Reading your balances…');
      const [ownerHex, onchain, balHex, priceHex] = await Promise.all([
        Y.ethCall(g.nfpm, Y.SEL.ownerOf + Y.word(t.id), null, rpcs),
        Y.readPosition(g.nfpm, t.id, rpcs),
        Y.rpcCall('eth_getBalance', [acct, 'latest'], rpcs),
        Y.rpcCall('eth_gasPrice', [], rpcs),
      ]);
      // increaseLiquidity adds the caller's tokens to any position, whoever
      // holds it, so one sent away since the last refresh would be a gift.
      if ('0x' + Y.wordsOf(ownerHex)[0].toString(16).padStart(40, '0') !== acct) throw new Error(`The connected wallet no longer holds #${t.id}. Refresh the page.`);
      if (onchain.token0 !== g.token0.address || onchain.token1 !== g.token1.address) throw new Error('Position does not match this pair');
      const need = 4n * COMPOUND_GAS * BigInt(priceHex);
      if (BigInt(balHex) < need) {
        const f = (w) => fmtAmt(Number(w) / 1e18);
        throw new Error(`An add needs about ${f(need / 2n)} ${chain.native} for gas and at least as much again must stay in the wallet (${f(need)} ${chain.native} in all); `
          + `the wallet has ${f(BigInt(balHex))} ${chain.native}. Add ${chain.native} and try again.`);
      }
      const tu = await topUpContext(g, 0n, 0n, null);
      if (!(tu.lMax > 0)) throw new Error('Your wallet has nothing that fits this range at the current price.');
      const res = await addModal(g, tu);
      const x = res.ok ? Y.topUpAt(tu, res.t) : null;
      if (!x || (x.n0 === 0n && x.n1 === 0n)) { delete state.status[key]; renderList(); return false; }

      if (x.wrap > 0n) {
        // The position manager pays a side all in native or all in the
        // wrapped token, never a mix, so native is wrapped first.
        await checkNativeReserve(g.chain, chain.wrapped, Y.SEL.deposit, { value: x.wrap, compoundGas: tu.compoundGas });
        setStatus(key, `${label}: wrap ${fmtAmt(Number(x.wrap) / 1e18)} ${esc(chain.native)} in your wallet…`);
        const wh = await sendTx(Y.SEL.deposit, chain.wrapped, x.wrap);
        setStatus(key, `${label}: wrapping ${txLink(wh, g.chain)}…`);
        const wrc = await waitReceipt(wh, rpcs);
        if (wrc.status !== '0x1') throw new Error('Wrapping ' + chain.native + ' failed');
      }
      await ensureAllowance(g, g.token0, x.n0, label);
      await ensureAllowance(g, g.token1, x.n1, label);

      setStatus(key, 'Simulating…');
      const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
      const sim = await Y.ethCall(g.nfpm, Y.buildAddData({ targetId: t.id, amount0: x.n0, amount1: x.n1, deadline }), acct, rpcs);
      const r = Y.decodeIncreaseResult(sim);
      const bps = state.prefs.slippageBps;
      const data = Y.buildAddData({ targetId: t.id, amount0: x.n0, amount1: x.n1,
        min0: Y.withSlippage(r.used0, bps), min1: Y.withSlippage(r.used1, bps), deadline });

      // The wallet may have been moved off this chain while the modal was open.
      if (state.chainId !== chain.id) await switchChain(g.chain);
      await Y.ethCall(g.nfpm, data, acct, rpcs);
      const gas = await gasQuote(g.nfpm, data, g.chain);
      await checkNativeReserve(g.chain, g.nfpm, data, { compoundGas: gas ? gas.units : null });
      setStatus(key, 'Confirm in your wallet…');
      const hash = await sendTx(data, g.nfpm);
      setStatus(key, `Pending ${txLink(hash, g.chain)}…`);
      const rc = await waitReceipt(hash, rpcs);
      if (rc.status !== '0x1') throw new Error('Transaction reverted ' + hash);
      const used0 = Y.toUnits(r.used0, g.token0.decimals), used1 = Y.toUnits(r.used1, g.token1.decimals);
      const usd = used0 * g.token0.usd + used1 * g.token1.usd;
      setStatus(key, `Added ${fmtAmt(used0)} ${esc(g.token0.symbol)} + ${fmtAmt(used1)} ${esc(g.token1.symbol)}${usd > 0 ? ` (${fmtUsd(usd)})` : ''} from your wallet to #${esc(t.id)} ${txLink(hash, g.chain)}`, 'ok');
      return true;
    } catch (e) {
      setStatus(key, esc(e && e.code === 4001 ? 'Rejected in wallet.' : (e.message || String(e))), 'bad');
      return false;
    }
  }

  /**
   * How much to add: a slider from nothing to the most that fits (where it
   * starts), with the deposit panel showing what goes in per token and where
   * it comes from. Resolves { ok, t } with t in 0..1 for topUpAt.
   */
  function addModal(g, tu) {
    const t = g.target, chain = Y.chainOf(g.chain), nat = esc(chain.native);
    const sym0 = esc(g.token0.symbol), sym1 = esc(g.token1.symbol);
    const d0 = g.token0.decimals, d1 = g.token1.decimals, usd0 = g.token0.usd || 0, usd1 = g.token1.usd || 0;
    const units = (raw, dec) => Number(raw) / 10 ** dec;
    const view = (pos) => {
      const x = Y.topUpAt(tu, pos);
      const a0 = units(x.n0, d0), a1 = units(x.n1, d1), total = a0 * usd0 + a1 * usd1;
      const from = (a, s, held, dec, i) => (!(a > 0) ? 'none at this range'
        : tu.wrappedIndex === i && s.fromNative > 0n
          ? `${fmtAmt(units(s.fromWallet, dec))} W${nat} you hold<br><span class="w">+ ${fmtAmt(Number(s.fromNative) / 1e18)} ${nat} wrapped first</span>`
          : `of ${fmtAmt(units(held, dec))} in your wallet`);
      const nativeAfter = tu.nativeBal - 2n * tu.compoundGas * tu.price - (x.wrap > 0n ? x.wrap + tu.wrapCost : 0n);
      return {
        empty: x.n0 === 0n && x.n1 === 0n, wraps: x.wrap > 0n, nativeAfter: Number(nativeAfter) / 1e18,
        html: `<div class="dep-h"><span>Going into #${esc(t.id)}</span><span class="dep-badge">all from your wallet</span></div>
          <div class="dep-total">≈ ${fmtUsd(total)}</div>
          <div class="dep-sub">${usd0 > 0 && usd1 > 0 ? 'Your own tokens, at the pool\'s current price' : 'A token has no price, so the $ total leaves it out'}</div>
          <div class="dep-tok"><span class="dep-amt">${fmtAmt(a0)}<span class="sym">${sym0}</span></span><span class="dep-from">${from(a0, x.s0, tu.wallet0, d0, 0)}</span></div>
          <div class="dep-tok"><span class="dep-amt">${fmtAmt(a1)}<span class="sym">${sym1}</span></span><span class="dep-from">${from(a1, x.s1, tu.wallet1, d1, 1)}</span></div>`,
      };
    };
    const v0 = view(1);
    const rows = [
      ['Into', `#${esc(t.id)} · ${feePct(t.feeTier)} · ${t.inRange ? 'in range' : 'out of range'}${t.estApr == null ? '' : ` · est. ${fmtPct(t.estApr)} APR`}`],
      ['From', esc(walletName(g.owner))],
      ['Network', esc(g.chainName)],
      ['Network fee', 'Your wallet will show it, plus any approvals'],
      [`${nat} left after gas`, `≈ <span id="mNative">${fmtAmt(v0.nativeAfter)}</span> ${nat}<br><span style="color:var(--dim)">keeps at least ${fmtAmt(Number(tu.reserve) / 1e18)}</span>`],
    ];
    const single = !t.inRange ? (t.tick < t.tickLower ? sym0 : sym1) : null;
    return new Promise((resolve) => {
      const root = $('modalRoot');
      root.innerHTML = `<div class="modal-bg" id="mbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mh">
        <h2 id="mh">Add to ${sym0} / ${sym1}</h2>
        <div class="dep wallet" id="mDep" aria-live="polite">${v0.html}</div>
        <div class="topup">
          <div class="topup-h"><span>How much</span><span id="mPct">Most that fits</span></div>
          <input type="range" id="mTop" min="0" max="1000" step="1" value="1000" aria-label="How much to add from your wallet">
          <div class="topup-ends"><span>Nothing</span><span>Most that fits</span></div>
        </div>
        ${rows.map(([k, v]) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
        ${single ? `<p class="note warn">#${esc(t.id)} is out of range, so it takes only ${single} and earns no fees until the price comes back into its range.</p>` : ''}
        <p class="note">Adds ${sym0} and ${sym1} from your wallet to #${esc(t.id)}. Its unclaimed fees are not touched (Compound or Collect does that). Nothing is swapped: the amounts are what fits the range at today's price, and the rest stays in your wallet.${tu.wrappedIndex >= 0 ? ` When the W${nat} you hold isn't enough, ${nat} is wrapped to W${nat} in a separate transaction first.` : ''} At least ${fmtAmt(Number(tu.reserve) / 1e18)} ${nat}, twice the cost of a compound, always stays in the wallet. A simulation after you confirm sets the exact amounts, with minimums ${(state.prefs.slippageBps / 100).toFixed(2)}% under it.</p>
        <div class="modal-actions"><button class="btn" type="button" id="mNo">Cancel</button><button class="btn primary" type="button" id="mYes">${v0.wraps ? 'Wrap, then confirm in wallet' : 'Confirm in wallet'}</button></div>
      </div></div>`;
      const range = $('mTop');
      const done = (ok) => { const pos = Number(range.value) / 1000; root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve({ ok, t: pos }); };
      range.addEventListener('input', () => {
        const pos = Number(range.value) / 1000, v = view(pos);
        $('mDep').innerHTML = v.html;
        $('mNative').textContent = fmtAmt(v.nativeAfter);
        $('mPct').textContent = pos === 1 ? 'Most that fits' : Math.round(pos * 100) + '%';
        $('mYes').disabled = v.empty;
        $('mYes').textContent = v.wraps ? 'Wrap, then confirm in wallet' : 'Confirm in wallet';
      });
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      document.addEventListener('keydown', onKey);
      $('mNo').onclick = () => done(false);
      $('mYes').onclick = () => done(true);
      $('mbg').onclick = (e) => { if (e.target.id === 'mbg') done(false); };
      $('mYes').focus();
    });
  }

  // ---------- send a position (the V3 NFT) to another address ----------
  /**
   * Check a typed destination for position p: { to, cs, warn } when it can
   * go there, { error } when not. Mixed case must pass EIP-55; an address in
   * one case carries no checksum, so it passes with a warning.
   */
  function checkDest(raw, p) {
    const s = raw.trim();
    if (!s) return { error: '' };
    if (!Y.isAddress(s)) return { error: 'Not an address: it needs 0x followed by 40 hex characters.' };
    const to = s.toLowerCase(), cs = Y.toChecksum(to), body = s.slice(2);
    const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
    if (mixed && s !== cs) return { error: "The checksum doesn't match, so a character is wrong. Copy the address again from where it came from." };
    if (/^0x0{40}$/.test(to)) return { error: 'That is the zero address: the position would be lost for good.' };
    if (to === p.nfpm) return { error: "That is this DEX's position manager: the position would be stuck in it." };
    if (Object.values(Y.DEXES).some((d) => d.nfpm === to)) return { error: "That is a DEX's position manager, not a wallet." };
    if (to === p.owner) return { error: 'That is the wallet that already holds it.' };
    if (to === p.token0.address || to === p.token1.address || to === (p.poolId || '').toLowerCase()) return { error: "That is this pair's token or pool contract, not a wallet." };
    return { to, cs, warn: mixed ? '' : 'This address is all one case, so it has no checksum to catch a typo: compare every character with where you copied it from.' };
  }

  /**
   * Everything checked before a send can be signed: the connected wallet still
   * owns the position, the exact transaction dry-runs (safeTransferFrom reverts
   * on a contract that can't take ERC-721s), and the native reserve survives
   * the gas. Throws with the reason; nothing has been sent at that point.
   */
  async function preflightSend(p, to) {
    const chain = Y.chainOf(p.chain), rpcs = chain.rpcs, acct = state.account;
    if (!acct || p.owner !== acct) throw new Error('Connect the wallet that holds this position.');
    const [ownerHex, code] = await Promise.all([
      Y.ethCall(p.nfpm, Y.SEL.ownerOf + Y.word(p.id), null, rpcs),
      Y.rpcCall('eth_getCode', [to, 'latest'], rpcs),
    ]);
    const owner = '0x' + Y.wordsOf(ownerHex)[0].toString(16).padStart(40, '0');
    if (owner !== acct) throw new Error(`The connected wallet no longer holds #${p.id}. Refresh the page.`);
    // EIP-7702 wallets carry a 0xef0100… delegation as code but are still wallets.
    const contract = !!code && code !== '0x' && !/^0xef0100/i.test(code);
    const data = Y.buildSendData({ owner: acct, to, tokenId: p.id });
    try {
      await Y.ethCall(p.nfpm, data, acct, rpcs);
    } catch (e) {
      throw new Error(`The dry run failed, so nothing was sent (${Y.revertReason(e)}).${contract ? ' That address is a contract that probably cannot receive V3 positions.' : ''}`);
    }
    const gas = await gasQuote(p.nfpm, data, p.chain);
    await checkNativeReserve(p.chain, p.nfpm, data);
    return { data, gas, contract };
  }

  /** The address step, then the review step. Resolves { to } or null. */
  function sendModal(p) {
    const chain = Y.chainOf(p.chain);
    const s0 = esc(p.token0.symbol), s1 = esc(p.token1.symbol);
    const posLine = `${s0} / ${s1} #${esc(p.id)}<br><span style="color:var(--dim)">${esc(p.dexLabel)} · ${feePct(p.feeTier)} · ${esc(chain.name)}</span>`;
    return new Promise((resolve) => {
      const root = $('modalRoot');
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      const close = (v) => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
      document.addEventListener('keydown', onKey);
      const frame = (inner) => {
        root.innerHTML = `<div class="modal-bg" id="mbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mh">${inner}</div></div>`;
        $('mbg').onclick = (e) => { if (e.target.id === 'mbg') close(null); };
      };
      const ask = (value = '', failure = '') => {
        frame(`<h2 id="mh">Send position</h2>
          <div class="kv"><div class="k">Position</div><div class="v">${posLine}</div></div>
          <div class="kv"><div class="k">Value</div><div class="v">${fmtUsd(p.value)}${p.claimUsd >= 0.01 ? `<br><span style="color:var(--dim)">+ ${fmtUsd(p.claimUsd)} unclaimed fees</span>` : ''}</div></div>
          <label for="sTo" class="note" style="display:block;color:var(--text);font-weight:600">Send to (an address on ${esc(chain.name)})</label>
          <input id="sTo" class="send-in mono" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="0x…" value="${esc(value)}">
          <div class="send-msg" id="sMsg" aria-live="polite"></div>
          <p class="note">Moves the position NFT itself, with its liquidity and any unclaimed fees, to that address. Nothing is swapped or withdrawn.</p>
          <div class="modal-actions"><button class="btn" type="button" id="mNo">Cancel</button><button class="btn primary" type="button" id="mYes" disabled>Review</button></div>`);
        const input = $('sTo'), msg = $('sMsg'), yes = $('mYes');
        const validate = () => {
          const r = checkDest(input.value, p);
          input.classList.toggle('bad', !!r.error);
          msg.className = 'send-msg' + (r.error ? ' bad' : r.to && !r.warn ? ' ok' : '');
          msg.textContent = r.error || (r.to ? (r.warn || 'Valid address, checksum matches.') + (walletIndex(r.to) >= 0 ? ` Tracked here as ${walletName(r.to)}.` : '') : '');
          yes.disabled = !r.to;
          return r;
        };
        input.addEventListener('input', validate);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !yes.disabled) yes.click(); });
        if (value) validate();
        if (failure) { msg.className = 'send-msg bad'; msg.textContent = failure; }
        $('mNo').onclick = () => close(null);
        yes.onclick = async () => {
          const r = validate();
          if (!r.to) return;
          yes.disabled = true; input.disabled = true; yes.textContent = 'Checking…';
          try { review(input.value.trim(), r, await preflightSend(p, r.to)); } catch (e) { ask(input.value, e.message || String(e)); }
        };
        input.focus();
      };
      const review = (typed, r, chk) => {
        frame(`<h2 id="mh">Send ${s0} / ${s1} #${esc(p.id)}?</h2>
          <div class="kv"><div class="k">Position</div><div class="v">${posLine}</div></div>
          <div class="kv"><div class="k">Holds</div><div class="v">${fmtAmt(p.amt0)} ${s0} + ${fmtAmt(p.amt1)} ${s1}<br>${fmtUsd(p.value)}</div></div>
          <div class="kv"><div class="k">Unclaimed fees, sent with it</div><div class="v">${fmtAmt(p.fee0)} ${s0} + ${fmtAmt(p.fee1)} ${s1}<br>${fmtUsd(p.claimUsd)}</div></div>
          <div class="kv"><div class="k">From</div><div class="v">${esc(walletName(p.owner))}</div></div>
          <div class="note" style="color:var(--text);font-weight:600">To</div>
          <div class="send-to mono">${esc(r.cs)}</div>
          ${walletIndex(r.to) >= 0 ? `<p class="note">Tracked on this page as <b>${esc(walletName(r.to))}</b>.</p>` : ''}
          ${r.warn ? `<p class="note warn">${esc(r.warn)}</p>` : ''}
          ${chk.contract ? '<p class="note warn">This address is a contract, not a plain wallet. It accepted the position in the dry run, but only send if you know who controls it (a Safe multisig, for example).</p>' : ''}
          <div class="kv"><div class="k">Network fee</div><div class="v">${chk.gas ? `≈ ${fmtAmt(chk.gas.native)} ${esc(chk.gas.symbol)}${chk.gas.usd ? ` (${fmtUsd(chk.gas.usd)})` : ''}` : 'Your wallet will show it'}</div></div>
          <div class="send-warn">This cannot be undone. The position and its unclaimed fees will belong to the address above, and only whoever controls that address can send them back.</div>
          <label class="modal-toggle"><input type="checkbox" id="sOk"> I've checked the address character by character</label>
          <div class="modal-actions"><button class="btn" type="button" id="mBack">Back</button><button class="btn danger" type="button" id="mYes" disabled>Send position</button></div>`);
        $('sOk').onchange = (e) => { $('mYes').disabled = !e.target.checked; };
        $('mBack').onclick = () => ask(typed);
        $('mYes').onclick = () => close({ to: r.to });
      };
      ask();
    });
  }

  async function runSend(p, to) {
    const key = p.uid, chain = Y.chainOf(p.chain);
    try {
      if (state.chainId !== chain.id) {
        setStatus(key, `Switch your wallet to ${esc(chain.name)}…`);
        await switchChain(p.chain);
        renderConnect();
      }
      // Again just before signing: the review may have sat open a while.
      setStatus(key, 'Checking…');
      const { data } = await preflightSend(p, to);
      setStatus(key, 'Confirm the transfer in your wallet…');
      const hash = await sendTx(data, p.nfpm);
      setStatus(key, `Sending ${txLink(hash, p.chain)}…`);
      const rc = await waitReceipt(hash, chain.rpcs);
      if (rc.status !== '0x1') throw new Error('Transaction reverted ' + hash);
      // The row leaves the list on the refresh that follows, so say it up top
      // too; it stays on the row while the 9mm data lags the chain.
      const sent = `Sent ${esc(p.token0.symbol)} / ${esc(p.token1.symbol)} #${esc(p.id)} to <span class="mono">${esc(Y.toChecksum(to))}</span> ${txLink(hash, p.chain)}`;
      state.noticeHtml = sent;
      setStatus(key, sent, 'ok');
      return true;
    } catch (e) {
      setStatus(key, esc(e && e.code === 4001 ? 'Rejected in wallet.' : (e.message || String(e))), 'bad');
      return false;
    }
  }

  function simpleConfirm(title, text) {
    return new Promise((resolve) => {
      const root = $('modalRoot');
      root.innerHTML = `<div class="modal-bg" id="mbg"><div class="modal" role="dialog" aria-modal="true">
        <h2>${esc(title)}</h2><p class="note" style="margin-top:0">${esc(text)}</p>
        <div class="modal-actions"><button class="btn" type="button" id="mNo">Cancel</button><button class="btn primary" type="button" id="mYes">Continue</button></div>
      </div></div>`;
      const done = (v) => { root.innerHTML = ''; resolve(v); };
      $('mNo').onclick = () => done(false);
      $('mYes').onclick = () => done(true);
      $('mbg').onclick = (e) => { if (e.target.id === 'mbg') done(false); };
    });
  }

  function settingsModal() {
    const f = state.prefs;
    const root = $('modalRoot');
    root.innerHTML = `<div class="modal-bg" id="mbg"><div class="modal" role="dialog" aria-modal="true">
      <h2>Settings</h2>
      <div class="settings-grid">
        <label>Slippage tolerance (%)<input type="number" id="sSlip" min="0.1" max="5" step="0.1" value="${(f.slippageBps / 100).toFixed(1)}"></label>
        <label>Token approvals
          <select id="sAppr">
            <option value="exact"${f.approve === 'exact' ? ' selected' : ''}>Exact amount each time</option>
            <option value="unlimited"${f.approve === 'unlimited' ? ' selected' : ''}>Unlimited (fewer prompts)</option>
          </select>
        </label>
        <label>Collected WPLS / WETH
          <select id="sUnwrap">
            <option value="keep"${f.unwrapNative ? '' : ' selected'}>Keep wrapped</option>
            <option value="native"${f.unwrapNative ? ' selected' : ''}>Receive as PLS / ETH</option>
          </select>
        </label>
      </div>
      <p class="note">Approvals go to each DEX's own position manager (${Object.values(Y.DEXES).map((d) => `${esc(d.label)} <span class="mono">${d.nfpm.slice(0, 8)}…</span>`).join(', ')}), so a token approved on one DEX still needs approving on another. Exact approvals cost an extra prompt per token each time; unlimited ones are remembered by the token until you revoke them.
        "Receive as PLS / ETH" applies to Collect only: compounding always re-adds the fees as WPLS / WETH.</p>
      <div class="modal-actions"><button class="btn" type="button" id="mNo">Cancel</button><button class="btn primary" type="button" id="mYes">Save</button></div>
    </div></div>`;
    const done = () => { root.innerHTML = ''; };
    $('mNo').onclick = done;
    $('mbg').onclick = (e) => { if (e.target.id === 'mbg') done(); };
    $('mYes').onclick = () => {
      const slip = Math.min(5, Math.max(0.1, parseFloat($('sSlip').value) || 1));
      f.slippageBps = Math.round(slip * 100);
      f.approve = $('sAppr').value === 'unlimited' ? 'unlimited' : 'exact';
      f.unwrapNative = $('sUnwrap').value === 'native';
      savePrefs(); done(); renderList();
    };
  }

  /** A short-lived message about an action (wallet, network), not a load failure. */
  function showError(msg) { state.notice = msg; renderBanner(); setTimeout(() => { if (state.notice === msg) { state.notice = null; renderBanner(); } }, 8000); }

  // ---------- wallet list ----------
  function addWallets(text) {
    const found = (text.match(/0x[0-9a-fA-F]{40}/g) || []).map((a) => a.toLowerCase());
    let added = 0;
    for (const a of found) {
      if (walletIndex(a) >= 0) continue;
      state.wallets.push({ address: a, label: '' });
      added++;
    }
    if (!found.length) { showError('No 0x addresses found in that text.'); return; }
    saveWallets();
    $('addInput').value = '';
    if (added) refresh(); else render();
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const addr = el.dataset.addr;
    const find = () => state.groups.find((g) => g.key === el.dataset.key);
    if (act === 'filterWallet') {
      state.prefs.wallet = state.prefs.wallet === addr ? 'all' : addr; savePrefs(); render();
    } else if (act === 'rename') {
      e.stopPropagation();
      const w = state.wallets[walletIndex(addr)];
      const name = prompt('Label for ' + shortAddr(addr), w.label || '');
      if (name != null) { w.label = name.trim().slice(0, 40); saveWallets(); render(); }
    } else if (act === 'remove') {
      e.stopPropagation();
      if (!confirm('Stop tracking ' + walletName(addr) + '?')) return;
      state.wallets = state.wallets.filter((w) => w.address !== addr);
      if (state.prefs.wallet === addr) state.prefs.wallet = 'all';
      saveWallets(); savePrefs();
      state.positions = state.positions.filter((p) => p.owner !== addr);
      state.groups = Y.buildGroups(state.positions);
      render();
    } else if (act === 'sort') {
      const k = el.dataset.key;
      if (state.prefs.sort === k) state.prefs.dir = state.prefs.dir === 'desc' ? 'asc' : 'desc';
      else { state.prefs.sort = k; state.prefs.dir = k === 'pair' || k === 'wallet' ? 'asc' : 'desc'; }
      savePrefs(); render();
    } else if (act === 'connect') {
      e.stopPropagation();
      const list = availableProviders();
      if (list.length === 1) connect(list[0]);
      else { state.pickerOpen = !state.pickerOpen; renderConnect(); }
    } else if (act === 'pick') {
      e.stopPropagation();
      connect(availableProviders()[Number(el.dataset.i)]);
    } else if (act === 'disconnect') {
      disconnect();
    } else if (act === 'netMenu') {
      state.netMenuOpen = !state.netMenuOpen; renderConnect();
    } else if (act === 'pickNet') {
      const key = el.dataset.chain;
      state.netMenuOpen = false;
      if (!Y.CHAINS[key] || Y.CHAINS[key].id === state.chainId) { renderConnect(); return; }
      state.switching = true; renderConnect();
      try {
        await switchChain(key);
      } catch (err) {
        showError(err && err.code === 4001 ? 'Network switch rejected in wallet.' : 'Could not switch network: ' + (err.message || err));
      } finally {
        state.switching = false; render();
      }
    } else if (act === 'trackMe') {
      addWallets(state.account);
    } else if (act === 'compound' || act === 'collect') {
      const p = state.positions.find((x) => x.uid === el.dataset.uid);
      if (!p || state.running) return;
      const g = actionGroup(p, act);
      state.running = true; renderList();
      const ok = await runGroup(g, act);
      state.running = false;
      if (ok) await refresh(); else renderList();
    } else if (act === 'add') {
      const p = state.positions.find((x) => x.uid === el.dataset.uid);
      if (!p || state.running) return;
      state.running = true; renderList();
      const ok = await runAdd(p);
      state.running = false;
      if (ok) await refresh(); else renderList();
    } else if (act === 'send') {
      const p = state.positions.find((x) => x.uid === el.dataset.uid);
      if (!p || state.running) return;
      const res = await sendModal(p);
      if (!res) return;
      state.running = true; renderList();
      const ok = await runSend(p, res.to);
      state.running = false;
      if (ok) await refresh(); else renderList();
    } else if (act === 'compoundAll') {
      compoundAll();
    } else if (act === 'net') {
      const p = state.positions.find((x) => x.uid === el.dataset.uid);
      if (!p || state.netPopUid === p.uid) closeNetPop();
      else openNetPop(el, p);
    }
  });
  document.addEventListener('click', (e) => {
    // A click that re-rendered its own button leaves e.target detached; that
    // click belonged to the picker, so it must not close it.
    if (state.pickerOpen && e.target.isConnected && !e.target.closest('#connectArea')) { state.pickerOpen = false; renderConnect(); }
    if (state.netMenuOpen && e.target.isConnected && !e.target.closest('.net-switch')) { state.netMenuOpen = false; renderConnect(); }
    if (state.netPopUid && e.target.isConnected && !e.target.closest('#netPop, [data-act="net"]')) closeNetPop();
  });

  $('addBtn').addEventListener('click', () => addWallets($('addInput').value));
  $('addInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addWallets($('addInput').value); } });
  $('maskBtn').addEventListener('click', () => { state.prefs.mask = !state.prefs.mask; savePrefs(); render(); });
  $('settingsBtn').addEventListener('click', settingsModal);
  $('forgetBtn').addEventListener('click', () => {
    if (!confirm('Forget every tracked wallet and setting stored by this page in this browser?')) return;
    store.del(K.wallets); store.del(K.prefs); store.del(K.rdns);
    state.wallets = []; state.prefs = Object.assign({}, DEFAULT_PREFS);
    state.positions = []; state.groups = []; state.updatedAt = null; state.status = {};
    render();
  });
  $('byPairChk').addEventListener('change', (e) => { state.prefs.byPair = e.target.checked; savePrefs(); render(); });
  $('sortSel').addEventListener('change', (e) => { state.prefs.sort = e.target.value; savePrefs(); render(); });
  $('dirBtn').addEventListener('click', () => { state.prefs.dir = state.prefs.dir === 'desc' ? 'asc' : 'desc'; savePrefs(); render(); });
  $('qInput').addEventListener('input', (e) => { state.prefs.q = e.target.value.trim(); savePrefs(); renderSummary(); renderList(); });
  $('dexSel').addEventListener('change', (e) => { state.prefs.dex = e.target.value; savePrefs(); render(); });
  $('chainSel').addEventListener('change', (e) => { state.prefs.chain = e.target.value; savePrefs(); render(); });
  $('inRangeChk').addEventListener('change', (e) => { state.prefs.inRange = e.target.checked; savePrefs(); render(); });
  $('minClaim').addEventListener('input', (e) => { state.prefs.minClaim = Math.max(0, parseFloat(e.target.value) || 0); savePrefs(); renderSummary(); renderList(); });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.netPopUid) closeNetPop(); });

  // site menu
  const nb = $('siteNavBtn'), nm = $('siteNavMenu');
  nb.addEventListener('click', (e) => { e.stopPropagation(); const open = nm.classList.toggle('hidden') === false; nb.setAttribute('aria-expanded', open); });
  document.addEventListener('click', () => { nm.classList.add('hidden'); nb.setAttribute('aria-expanded', 'false'); });
  // The iOS app opens the arcade at ?embed=1 in a web view, and its links drop
  // the param, so remember it for the session. LP Yield stays hidden in there:
  // App Review objects to in-app links to wallet tools that sign transactions.
  let embedded = new URLSearchParams(location.search).get('embed') === '1';
  try { if (embedded) sessionStorage.setItem('ccEmbed', '1'); else embedded = sessionStorage.getItem('ccEmbed') === '1'; } catch (_) { /* storage blocked */ }
  if (!embedded) nm.querySelectorAll('a[data-app-hide]').forEach((a) => { a.hidden = false; });

  setInterval(() => { const u = $('updatedAt'); if (u) u.textContent = 'Updated ' + ago(state.updatedAt); }, 15000);

  // ---------- boot ----------
  if (state.prefs.wallet !== 'all' && walletIndex(state.prefs.wallet) < 0) state.prefs.wallet = 'all';
  // The DEX filter matches by name; older saved values were DEX keys, and
  // "9mm" on Ethereum is now Watergun, so anything that is not a current name
  // resets.
  if (state.prefs.dex !== 'all' && !Object.values(Y.DEXES).some((d) => d.label === state.prefs.dex)) state.prefs.dex = 'all';
  render();
  refresh();
  setTimeout(silentReconnect, 400); // give EIP-6963 wallets a moment to announce
})();

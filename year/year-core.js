// Year in Review, web edition: the facts behind the card, read in the browser.
//
// A port of the iOS app's wallet/libs/YearRollup.swift (the spec) and the text
// half of YearRollupRenderer.swift (RollupText). Everything is read from public
// sources for the pasted wallets, PulseChain only:
//
// - Activity: every transaction the wallets sent this year and every token
//   transfer in or out, from the Blockscout v2 API (FusionScan first, then
//   PulseScan), paged back to 1 January, at most 30 pages per list.
// - The stack: what the wallets held on 1 January and hold now (archive reads
//   through Multicall3 at the year's first block), both valued at TODAY's
//   DexScreener prices, so price moves cancel out.
//
// Dollar values and token amounts stay inside this file: they rank coins and
// work out changes. The card only ever gets percentages and counts.
//
// Works in the browser (window.YearCore) and in node (module.exports) for tests.

(function (root) {
  'use strict';

  const CFG = {
    explorers: ['https://scan.pulsefusion.io', 'https://api.scan.pulsechain.com'],
    // Both serve archive state (checked 2026-11-26), so either can answer the 1 January read.
    rpcs: ['https://rpc.pulsechain.com', 'https://369.rpc.thirdweb.com'],
    dexscreener: 'https://api.dexscreener.com/tokens/v1/pulsechain/',
    multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
    wpls: '0xa1077a294dde1b09bb078844df40758a5d0f9a27',
    hex: '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39',
    nativeSymbol: 'PLS',
    pageLimit: 30,
    multicallChunk: 120,
    // A deepest pair thinner than this is spam, whatever price it quotes.
    minLiquidity: 1000,
    // Coins under $1 at both ends are left out of the totals (the app's
    // default dust filter); the coin list needs $10 at one end.
    dust: 1,
    listMin: 10,
    valueCap: 100e9,
  };

  const STABLES = new Set(['DAI', 'USDC', 'USDT', 'USDL', 'USDS', 'BUSD', 'TUSD', 'FRAX', 'LUSD', 'PYUSD', 'USDP', 'GUSD', 'USDE']);

  // V3 position managers (9mm, Uniswap/Hedron, LibertySwap, 9inch, Switch), from wallet/config.swift.
  const POSITION_MANAGERS = new Set([
    '0xcc05bf158202b4f461ede8843d76dcd7bbad07f2',
    '0xc36442b4a4522e871399cd717abdd847ab11fe88',
    '0x19b1347900840e7a299f339868881750918fad91',
    '0x18a532b36a9f6b10b3fec5bf225c00a0ec89b79e',
    '0xbfd64d5f12ec1389460d02861cbbb939b99230c6',
  ]);

  const SEL = {
    balanceOf: '0x70a08231',
    decimals: '0x313ce567',
    getEthBalance: '0x4d2301cc',
    stakeCount: '0x33060d90',
    stakeLists: '0x2607443b',
    aggregate3: '0x82ad56cb',
  };

  // ---------- small helpers ----------
  const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
  const pad32 = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
  const toTag = (n) => '0x' + n.toString(16);
  const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

  /** A uint256 hex word as a Number (balances overflow 2^53; precision loss is fine here). */
  function wordAt(hex, w) {
    if (!hex) return 0;
    const h = strip(hex);
    const s = h.slice(w * 64, w * 64 + 64);
    if (s.length < 64) return 0;
    return Number(BigInt('0x' + s));
  }

  /** "2026-11-04T23:49:35.000000Z" as a Date (the six fractional digits dropped). */
  function parseDate(s) {
    if (typeof s !== 'string' || s.length < 19) return null;
    const t = Date.parse(s.slice(0, 19) + 'Z');
    return Number.isFinite(t) ? new Date(t) : null;
  }

  async function fetchT(url, opts = {}, ms = 30000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(new URL(url).host + ' timed out');
      throw e;
    } finally { clearTimeout(t); }
  }

  /** GET JSON from the first explorer that answers. `path` starts with "/". */
  async function explorerJSON(path, ms = 30000) {
    let lastErr;
    for (const base of CFG.explorers) {
      try {
        const res = await fetchT(base + path, {}, ms);
        if (!res.ok) throw new Error(new URL(base).host + ' HTTP ' + res.status);
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('No explorer answered');
  }

  // ---------- review year ----------
  /**
   * The year Year in Review covers on `date`: the calendar year, except in
   * January, which still reviews the year just ended.
   */
  function reviewYear(date = new Date()) {
    const y = date.getFullYear();
    return date.getMonth() === 0 ? y - 1 : y;
  }

  // ---------- explorer reads ----------
  /** First block at or after `date`. FusionScan answers {"result":"25412763"}, Blockscout {"result":{"blockNumber":"…"}}. */
  async function firstBlock(date) {
    const ts = Math.floor(date.getTime() / 1000);
    try {
      const j = await explorerJSON(`/api?module=block&action=getblocknobytime&timestamp=${ts}&closest=after`);
      if (typeof j.result === 'string') return parseInt(j.result, 10) || null;
      if (j.result && j.result.blockNumber) return parseInt(j.result.blockNumber, 10) || null;
    } catch (_) { /* fall through */ }
    return null;
  }

  /**
   * Every item of an address list (newest first) from `since` on, up to
   * pageLimit pages. Returns { items, capped, failed }: capped when the list
   * was cut short, failed when that was a later page failing on every
   * explorer rather than the page limit. `onPage(oldestDate)` after each
   * page. Throws only if the very first page fails on every explorer.
   */
  async function fetchYear(kind, query, address, since, onPage) {
    const items = [];
    let paging = {};
    for (let page = 0; page < CFG.pageLimit; page++) {
      const q = new URLSearchParams({ ...query, ...paging }).toString();
      let json;
      try {
        json = await explorerJSON(`/api/v2/addresses/${address}/${kind}${q ? '?' + q : ''}`);
        if (!json || !Array.isArray(json.items)) throw new Error('bad page');
      } catch (e) {
        if (page === 0) throw new Error(`Could not read ${kind} for ${short(address)}: ${e.message || e}`);
        return { items, capped: true, failed: true };
      }
      let reachedStart = false, oldest = null;
      for (const item of json.items) {
        const d = parseDate(item.timestamp);
        if (!d) continue;
        if (d < since) { reachedStart = true; break; }
        items.push(item);
        oldest = d;
      }
      if (oldest && onPage) onPage(oldest);
      const next = json.next_page_params;
      if (reachedStart || !next || typeof next !== 'object' || !Object.keys(next).length) return { items, capped: false, failed: false };
      paging = {};
      for (const [k, v] of Object.entries(next)) if (!(k in query)) paging[k] = String(v);
    }
    return { items, capped: true, failed: false };
  }

  /** ERC-20s the wallet holds now: { address: { decimals, symbol } }. */
  async function heldTokens(address) {
    try {
      const j = await explorerJSON(`/api?module=account&action=tokenlist&address=${address}`, 45000);
      const out = {};
      for (const t of Array.isArray(j.result) ? j.result : []) {
        if (t.type !== 'ERC-20' || !t.contractAddress || !t.balance || t.balance === '0') continue;
        out[t.contractAddress.toLowerCase()] = { decimals: t.decimals != null && t.decimals !== '' ? parseInt(t.decimals, 10) : null, symbol: t.symbol || '' };
      }
      return out;
    } catch (_) { return {}; }
  }

  // ---------- prices ----------
  /**
   * Today's USD price per token from DexScreener, 30 addresses a call. Takes
   * the deepest pair each token is in (as base; as quote only when it is in no
   * pair as base) and drops tokens whose deepest pair is under $1,000.
   * Returns { address: { price, liquidity, symbol } }.
   */
  async function prices(tokens, onProgress) {
    const list = [...new Set(tokens.map((t) => t.toLowerCase()))];
    const chunks = [];
    for (let i = 0; i < list.length; i += 30) chunks.push(list.slice(i, i + 30));
    const best = {}; // address -> { price, liquidity, symbol, base }
    let next = 0, done = 0;
    async function worker() {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        let pairs = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetchT(CFG.dexscreener + chunk.join(','), {}, 20000);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            pairs = Array.isArray(j) ? j : (j && j.pairs) || [];
            break;
          } catch (_) { /* one retry, then the chunk goes unpriced */ }
        }
        const want = new Set(chunk);
        for (const p of pairs) {
          if (!p || p.chainId !== 'pulsechain') continue;
          const liq = (p.liquidity && Number(p.liquidity.usd)) || 0;
          const usd = Number(p.priceUsd), native = Number(p.priceNative);
          const sides = [
            { t: p.baseToken, price: usd, base: true },
            { t: p.quoteToken, price: native > 0 ? usd / native : NaN, base: false },
          ];
          for (const s of sides) {
            const a = s.t && s.t.address && s.t.address.toLowerCase();
            if (!a || !want.has(a) || !(s.price > 0) || !Number.isFinite(s.price)) continue;
            const cur = best[a];
            // Base-side quotes beat quote-side ones; then the deeper pool wins.
            if (!cur || (s.base && !cur.base) || (s.base === cur.base && liq > cur.liquidity)) {
              best[a] = { price: s.price, liquidity: liq, symbol: s.t.symbol || '', base: s.base };
            }
          }
        }
        done++;
        if (onProgress) onProgress(done / chunks.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));
    const out = {};
    for (const [a, b] of Object.entries(best)) if (b.liquidity >= CFG.minLiquidity) out[a] = b;
    return out;
  }

  // ---------- RPC + Multicall3 ----------
  async function rpcOnce(url, method, params) {
    const res = await fetchT(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }, 30000);
    if (!res.ok) throw new Error(new URL(url).host + ' HTTP ' + res.status);
    const j = await res.json();
    if (j.error) throw new Error(new URL(url).host + ': ' + (j.error.message || 'error'));
    return j.result;
  }

  /**
   * One read raced across the RPCs: the first starts now, the next joins if it
   * hasn't answered in 2.5 s or fails, and the first good answer wins.
   * Reads only, so a duplicate request is harmless.
   */
  function rpcRace(method, params, rpcs = CFG.rpcs, hedgeMs = 2500) {
    return new Promise((resolve, reject) => {
      let started = 0, failed = 0, done = false, lastErr, timer;
      const launch = () => {
        if (done || started >= rpcs.length) return;
        const url = rpcs[started++];
        clearTimeout(timer);
        timer = setTimeout(launch, hedgeMs);
        rpcOnce(url, method, params).then((r) => {
          if (done) return;
          done = true; clearTimeout(timer); resolve(r);
        }, (e) => {
          lastErr = e; failed++;
          if (done) return;
          if (failed >= rpcs.length) { done = true; clearTimeout(timer); reject(lastErr); } else launch();
        });
      };
      launch();
    });
  }

  /** aggregate3 calldata for [[target, data], ...], every call allowed to fail. */
  function encAggregate3(list) {
    let head = '', tail = '', off = 32 * list.length;
    for (const [target, data] of list) {
      const d = strip(data);
      const el = addrWord(target) + word(1) + word(96) + word(d.length / 2) + pad32(d);
      head += word(off);
      tail += el;
      off += el.length / 2;
    }
    return SEL.aggregate3 + word(32) + word(list.length) + head + tail;
  }

  /** aggregate3's (bool success, bytes returnData)[] as hex strings, null for a failed call. */
  function decAggregate3(hex) {
    hex = strip(hex || '');
    const at = (byte) => BigInt('0x' + (hex.slice(byte * 2, byte * 2 + 64) || '0'));
    const base = Number(at(0)), n = Number(at(base)), start = base + 32, out = [];
    for (let i = 0; i < n; i++) {
      const el = start + Number(at(start + 32 * i));
      const ok = at(el) === 1n;
      const bytesAt = el + Number(at(el + 32));
      const len = Number(at(bytesAt));
      out.push(ok && len ? hex.slice((bytesAt + 32) * 2, (bytesAt + 32 + len) * 2) : null);
    }
    return out;
  }

  /** HEX's longest stake. */
  const MAX_STAKE_DAYS = 5555;

  /**
   * The stake length from a stakeStart call's input: HEX's
   * stakeStart(newStakedHearts, newStakedDays) and Hedron's
   * hexStakeStart(amount, length) both carry it in the second word.
   * 0 when the input is missing or out of range.
   */
  function stakeDaysOf(input) {
    const h = typeof input === 'string' ? strip(input) : '';
    if (h.length < 8 + 128) return 0;
    const d = parseInt(h.slice(8 + 64, 8 + 128), 16);
    return Number.isFinite(d) && d >= 1 && d <= MAX_STAKE_DAYS ? d : 0;
  }

  /** Many reads at one block, multicallChunk per eth_call. null when any chunk failed everywhere. */
  async function multiRead(calls, tag) {
    const out = [];
    for (let i = 0; i < calls.length; i += CFG.multicallChunk) {
      const chunk = calls.slice(i, i + CFG.multicallChunk);
      try {
        const raw = await rpcRace('eth_call', [{ to: CFG.multicall3, data: encAggregate3(chunk) }, tag]);
        const dec = decAggregate3(raw);
        if (dec.length !== chunk.length) return null;
        out.push(...dec);
      } catch (_) { return null; }
    }
    return out;
  }

  /**
   * Balances and staked HEX at the year's first block and now (or a finished
   * year's last block). `tokens` are ERC-20 addresses, `pairs` V2 LP tokens
   * minted this year (only their 1 January balance matters).
   */
  async function readHoldings(address, tokens, pairs, startBlock, endBlock) {
    const pad = addrWord(address);
    const calls = [];
    for (const t of tokens) calls.push([t, SEL.balanceOf + pad]);
    for (const p of pairs) calls.push([p, SEL.balanceOf + pad]);
    calls.push([CFG.multicall3, SEL.getEthBalance + pad]);
    calls.push([CFG.hex, SEL.stakeCount + pad]);

    const endTag = endBlock ? toTag(endBlock) : 'latest';
    const startTag = startBlock ? toTag(startBlock) : null;
    const [now, then] = await Promise.all([multiRead(calls, endTag), startTag ? multiRead(calls, startTag) : Promise.resolve(null)]);

    const h = { start: {}, end: {}, pairStart: {}, nativeStart: 0, nativeEnd: 0, stakedStart: 0, stakedEnd: 0, startOK: then != null, endOK: now != null };
    let i = 0;
    for (const t of tokens) { h.start[t] = then ? wordAt(then[i], 0) : 0; h.end[t] = now ? wordAt(now[i], 0) : 0; i++; }
    for (const p of pairs) { h.pairStart[p] = then ? wordAt(then[i], 0) : 0; i++; }
    h.nativeStart = then ? wordAt(then[i], 0) : 0; h.nativeEnd = now ? wordAt(now[i], 0) : 0; i++;
    const countThen = then ? wordAt(then[i], 0) : 0, countNow = now ? wordAt(now[i], 0) : 0;

    // One stakeLists(address, i) per stake: stakedHearts is word 1 (8
    // decimals), stakedDays word 4. Returns { hearts, lengths }.
    async function staked(count, tag) {
      if (!count) return { hearts: 0, lengths: [] };
      const list = [];
      for (let j = 0; j < Math.min(count, 500); j++) list.push([CFG.hex, SEL.stakeLists + pad + word(j)]);
      const res = await multiRead(list, tag);
      let hearts = 0;
      const lengths = [];
      for (const r of res || []) {
        if (!r || strip(r).length < 320) continue;
        hearts += wordAt(r, 1) / 1e8;
        const d = wordAt(r, 4);
        if (d >= 1 && d <= MAX_STAKE_DAYS) lengths.push(d);
      }
      return { hearts, lengths };
    }
    const [endStakes, startStakes] = await Promise.all([staked(countNow, endTag), startTag ? staked(countThen, startTag) : { hearts: 0, lengths: [] }]);
    h.stakedEnd = endStakes.hearts;
    h.stakedStart = startStakes.hearts;
    h.activeStakeDays = endStakes.lengths;
    return h;
  }

  /**
   * Transactions the wallet sent in each month so far, from its nonce (the
   * count of transactions it has ever sent) at each month's edge. `edges` are
   * block tags: the last block before each month starts, then the period's
   * end. Exact however busy the wallet is, and failed transactions count too,
   * since they use a nonce. null when any read fails or the numbers don't add up.
   */
  async function sentPerMonth(address, edges) {
    let nonces;
    try {
      nonces = await Promise.all(edges.map((tag) => rpcRace('eth_getTransactionCount', [address, tag])));
    } catch (_) { return null; }
    const n = nonces.map((h) => (typeof h === 'string' && /^0x[0-9a-f]+$/i.test(h) ? parseInt(h, 16) : NaN));
    const out = [];
    for (let i = 1; i < n.length; i++) {
      const d = n[i] - n[i - 1];
      if (!Number.isFinite(d) || d < 0) return null;
      out.push(d);
    }
    return out;
  }

  /** decimals() for tokens nobody told us about. */
  async function readDecimals(tokens) {
    if (!tokens.length) return {};
    const res = await multiRead(tokens.map((t) => [t, SEL.decimals]), 'latest');
    const out = {};
    tokens.forEach((t, i) => { const d = res && res[i] ? wordAt(res[i], 0) : null; if (d != null && d <= 36) out[t] = d; });
    return out;
  }

  // ---------- the rollup ----------
  /** Transactions in a year that make a wallet with no other story "Always On". */
  const BUSY_TRANSACTIONS = 1000;

  function storyOf(r) {
    if (r.transactions === 0) return 'heldSteady';
    if (isSteadyBuyer(r)) return 'steadyBuyer';
    // An LP manager swaps to rebalance before it adds; more adds than swaps
    // means liquidity is what the wallets were doing.
    const providing = r.newLPPositions > 0 || r.liquidityAdds >= 5;
    if (providing && r.liquidityAdds >= r.swaps) return 'liquidity';
    if (r.swaps >= 25) return 'trader';
    if (providing) return 'liquidity';
    if (r.stakesStarted > 0) return 'staker';
    const change = stackChangePercent(r);
    if (change != null) {
      if (change >= 5) return 'stacker';
      if (change <= -20 && r.cashOuts > 0) return 'tookProfits';
    } else if (startedFromZero(r)) {
      return 'stacker';
    }
    // Hundreds of sends and none of the above: a bot, usually. A sent list
    // cut short with no nonce to stand in already means 1,500 or more.
    if (r.transactions >= BUSY_TRANSACTIONS || r.transactionsExact === false) return 'busy';
    return 'holder';
  }

  function stackChangePercent(r) {
    const start = r.stackStartValue;
    if (start == null || start < 1 || start < r.stackEndValue * 0.002) return null;
    return (r.stackEndValue - start) / start * 100;
  }

  function startedFromZero(r) {
    const start = r.stackStartValue;
    if (start == null) return false;
    return r.stackEndValue >= 1 && (start < 1 || start < r.stackEndValue * 0.002);
  }

  function isSteadyBuyer(r) {
    return r.topBuySymbol != null && r.topBuyMonths >= 4 && r.topBuyMonths >= r.monthsElapsed / 2;
  }

  /**
   * Reads the chain for `addresses` and returns the rollup. `progress({fraction, detail})`.
   * `opts.year` overrides the review year; `opts.now` the clock (tests).
   */
  async function build(addresses, opts = {}) {
    const progress = opts.progress || (() => {});
    // Cancelling throws from the next progress report, which comes after every explorer page.
    const check = () => { if (opts.signal && opts.signal.aborted) throw new Error('Cancelled'); };
    const now = opts.now || new Date();
    const year = opts.year || reviewYear(now);
    const wallets = [...new Set(addresses.map((a) => a.toLowerCase()))];

    const yearStart = new Date(year, 0, 1);
    const nextYearStart = new Date(year + 1, 0, 1);
    if (yearStart > now) throw new Error(`${year} hasn't started yet.`);
    const finished = nextYearStart <= now;
    const periodEnd = finished ? new Date(nextYearStart.getTime() - 1000) : now;
    const monthsElapsed = finished ? 12 : Math.max(1, Math.min(12, now.getMonth() + 1));

    // Steps: per wallet two activity lists and one balance read, plus pricing.
    const steps = wallets.length * 3 + 1;
    let stepsDone = 0, detail = '';
    const span = Math.max(1, now - yearStart);
    const monthName = new Intl.DateTimeFormat('en', { month: 'long' });
    const report = (within) => check() || progress({ fraction: Math.min(1, (stepsDone + Math.min(1, Math.max(0, within))) / steps), detail });
    const step = () => { stepsDone++; report(0); };
    const paged = (name, oldest) => { detail = `${name}: reading ${monthName.format(oldest)}`; report((now - oldest) / span); };

    detail = 'Finding the first block of ' + year;
    report(0);
    const [startBlock, nextFirst] = await Promise.all([firstBlock(yearStart), finished ? firstBlock(nextYearStart) : Promise.resolve(null)]);
    const endBlock = finished && nextFirst ? nextFirst - 1 : null;

    const nativeKey = 'native';
    const key = (t) => (t === CFG.wpls ? nativeKey : t);

    // Activity
    let txCount = 0, swaps = 0, cashOuts = 0, stakesStarted = 0, stakesEnded = 0, newLP = 0, lpAdds = 0, capped = false;
    // Why a list was cut short: the page limit, or an explorer page that failed.
    let limited = false, readFailed = false;
    // Stake lengths in days: stakes started this year (from the stakeStart
    // input, so ones already ended count too) and every stake still running.
    const newStakes = { count: 0, days: 0 }, activeStakes = { count: 0, days: 0 };
    // False once a wallet's sent list was cut short and its nonce couldn't stand in.
    let txExact = true;
    // True once a wallet's nonce stood in: its active days are then far short.
    let sentFromNonce = false;
    // Block tags at the month edges, found once, the first time a wallet needs them.
    let edgesPromise = null;
    const monthEdges = () => edgesPromise || (edgesPromise = (async () => {
      const starts = [startBlock];
      for (let m = 1; m < monthsElapsed; m++) starts.push(await firstBlock(new Date(year, m, 1)));
      if (starts.some((b) => !b)) return null;
      return [...starts.map((b) => toTag(b - 1)), endBlock ? toTag(endBlock) : 'latest'];
    })());
    const days = new Set();
    const monthly = new Array(12).fill(0);
    const buyMonths = {};
    const soldSymbols = new Set();
    const pad2 = (n) => String(n).padStart(2, '0');
    const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

    // Per wallet, kept for the balance step.
    const perWallet = [];
    const tokenInfo = {}; // address -> { decimals, symbol }
    const noteToken = (a, decimals, symbol) => {
      const cur = tokenInfo[a] || (tokenInfo[a] = { decimals: null, symbol: '' });
      if (cur.decimals == null && decimals != null && Number.isFinite(decimals)) cur.decimals = decimals;
      if (!cur.symbol && symbol) cur.symbol = symbol;
    };

    for (const address of wallets) {
      const name = short(address);
      paged(name, now);
      const tx = await fetchYear('transactions', { filter: 'from' }, address, yearStart, (d) => paged(name, d));
      step();
      paged(name, now);
      const lg = await fetchYear('token-transfers', {}, address, yearStart, (d) => paged(name, d));
      step();
      capped = capped || tx.capped || lg.capped;
      readFailed = readFailed || tx.failed || lg.failed;
      limited = limited || (tx.capped && !tx.failed) || (lg.capped && !lg.failed);

      const txs = [];
      for (const item of tx.items) {
        const date = parseDate(item.timestamp);
        if (!item.hash || !date || date >= nextYearStart || item.status === 'error') continue;
        const value = item.value == null ? '0' : String(item.value);
        txs.push({
          hash: item.hash.toLowerCase(), date, method: String(item.method || '').toLowerCase(),
          to: ((item.to && item.to.hash) || '').toLowerCase(), sentNative: value !== '0' && value !== '',
          input: typeof item.raw_input === 'string' ? item.raw_input : '',
        });
      }
      const legs = [];
      for (const item of lg.items) {
        const hash = item.transaction_hash || item.tx_hash;
        const date = parseDate(item.timestamp);
        const token = item.token;
        const tokenAddress = token && (token.address_hash || token.address);
        if (!hash || !date || date >= nextYearStart || !tokenAddress) continue;
        const from = ((item.from && item.from.hash) || '').toLowerCase();
        const to = ((item.to && item.to.hash) || '').toLowerCase();
        if (from !== address && to !== address) continue;
        legs.push({
          hash: hash.toLowerCase(), date, incoming: to === address, token: tokenAddress.toLowerCase(),
          tokenType: token.type || '', symbol: token.symbol || '', name: token.name || '',
          minted: item.type === 'token_minting', decimals: token.decimals != null ? parseInt(token.decimals, 10) : null,
        });
      }
      const legsByTx = {};
      for (const l of legs) (legsByTx[l.hash] || (legsByTx[l.hash] = [])).push(l);

      // The app also knows the wallet's LP positions from its database; here
      // only the token name tells an LP token apart.
      const isLPToken = (leg) => {
        if (leg.tokenType === 'ERC-721') return POSITION_MANAGERS.has(leg.token);
        const n = leg.name.toUpperCase(), s = leg.symbol.toUpperCase();
        return n.endsWith(' LP') || n.includes(' LP ') || n.includes('LP TOKEN')
          || s.endsWith('-LP') || s === 'PLP' || s === 'UNI-V2' || s === 'SLP';
      };
      const display = (t, fallback) => {
        if (t === CFG.wpls) return CFG.nativeSymbol;
        if (t === CFG.hex) return 'HEX';
        return fallback || (tokenInfo[t] && tokenInfo[t].symbol) || '';
      };

      // V2 LP tokens minted to the wallet this year, checked against the
      // 1 January balance to tell a new position from a top-up.
      const mintedPairs = new Set();

      // A wallet with more sent transactions than the page reads (a bot,
      // usually) gets its count and months from its nonce instead.
      let sent = null;
      if (tx.capped) {
        detail = `${name}: counting transactions`;
        report(0);
        const edges = await monthEdges();
        sent = edges ? await sentPerMonth(address, edges) : null;
        if (!sent) txExact = false;
        else sentFromNonce = true;
      }
      if (sent) {
        sent.forEach((c, m) => { monthly[m] += c; txCount += c; });
      }

      for (const t of txs) {
        days.add(dayKey(t.date));
        const month = t.date.getMonth();
        if (!sent) { txCount++; monthly[month]++; }

        if (t.method.includes('stakestart')) {
          stakesStarted++;
          const d = stakeDaysOf(t.input);
          if (d) { newStakes.count++; newStakes.days += d; }
          continue;
        }
        if (t.method.includes('stakeend')) { stakesEnded++; continue; }

        const txLegs = legsByTx[t.hash] || [];
        const lpLegs = txLegs.filter(isLPToken);
        if (POSITION_MANAGERS.has(t.to) || t.method.includes('liquidity') || lpLegs.length) {
          const sentCoins = txLegs.some((l) => !l.incoming && !isLPToken(l)) || t.sentNative;
          if (sentCoins) lpAdds++;
          for (const l of lpLegs) {
            if (!l.incoming || !l.minted) continue;
            if (l.tokenType === 'ERC-721') newLP++; else mintedPairs.add(l.token);
          }
          continue;
        }

        const ins = new Set(txLegs.filter((l) => l.incoming).map((l) => key(l.token)));
        const outs = new Set(txLegs.filter((l) => !l.incoming).map((l) => key(l.token)));
        if (t.sentNative) outs.add(nativeKey);
        if (t.method.includes('swap') && !ins.size && outs.size) ins.add(nativeKey);
        // Wrapping or unwrapping the native coin has the same key on both sides.
        const isSwap = ins.size && outs.size && [...ins].every((k) => !outs.has(k));
        if (!isSwap) continue;
        swaps++;

        const symbols = {};
        for (const l of txLegs) { const k = key(l.token); if (!(k in symbols)) symbols[k] = display(l.token, l.symbol); }
        const sym = (k) => (k === nativeKey ? CFG.nativeSymbol : (symbols[k] || ''));
        const bought = [...ins].map(sym).filter(Boolean);
        if (bought.length && bought.every((s) => STABLES.has(s.toUpperCase()))) cashOuts++;
        for (const s of bought) if (!STABLES.has(s.toUpperCase())) (buyMonths[s] || (buyMonths[s] = new Set())).add(month);
        for (const k of outs) soldSymbols.add(sym(k));
      }

      // Coins for the stack: what the wallet holds now plus every ERC-20 it moved this year.
      const tokens = new Set();
      for (const l of legs) if (l.tokenType === 'ERC-20') { tokens.add(l.token); noteToken(l.token, l.decimals, l.symbol); }
      perWallet.push({ address, name, tokens, mintedPairs });
    }

    // Held tokens for every wallet, then one pricing pass over the union.
    detail = 'Pricing coins';
    report(0);
    for (const w of perWallet) {
      const held = await heldTokens(w.address);
      for (const [a, info] of Object.entries(held)) { w.tokens.add(a); noteToken(a, info.decimals, info.symbol); }
      w.tokens.add(CFG.hex);
      for (const p of w.mintedPairs) w.tokens.delete(p);
    }
    const all = new Set();
    for (const w of perWallet) for (const t of w.tokens) all.add(t);
    all.add(CFG.wpls);
    all.add(CFG.hex);
    const priced = await prices([...all], (f) => report(f));
    noteToken(CFG.hex, 8, 'HEX');
    noteToken(CFG.wpls, 18, 'WPLS');
    const unknownDecimals = Object.keys(priced).filter((t) => !tokenInfo[t] || tokenInfo[t].decimals == null);
    const extra = await readDecimals(unknownDecimals);
    for (const [t, d] of Object.entries(extra)) noteToken(t, d, '');
    step();

    const nativePrice = (priced[CFG.wpls] && priced[CFG.wpls].price) || 0;
    const hexPrice = (priced[CFG.hex] && priced[CFG.hex].price) || 0;
    const symbolFor = (t) => (t === CFG.wpls ? CFG.nativeSymbol : t === CFG.hex ? 'HEX' : (tokenInfo[t] && tokenInfo[t].symbol) || (priced[t] && priced[t].symbol) || '');

    // Stack
    const startQty = {}, endQty = {}, priceOf = {}, symbolOf = {};
    let startValue = 0, endValue = 0, startKnown = false, endKnown = false;
    const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };

    for (const w of perWallet) {
      detail = `${w.name}: reading 1 January balances`;
      report(0);
      const tokens = [...w.tokens].filter((t) => priced[t] && tokenInfo[t] && tokenInfo[t].decimals != null);
      const snap = await readHoldings(w.address, tokens, [...w.mintedPairs], startBlock, endBlock);
      step();
      if (snap.startOK) startKnown = true;
      if (snap.endOK) endKnown = true;
      for (const d of snap.activeStakeDays) { activeStakes.count++; activeStakes.days += d; }

      // Liquid coins. Spam rules only (dust, thin pools, the bad-data cap).
      for (const t of tokens) {
        const unit = Math.pow(10, tokenInfo[t].decimals);
        const q0 = (snap.start[t] || 0) / unit, q1 = (snap.end[t] || 0) / unit;
        const p = priced[t].price;
        const v0 = q0 * p, v1 = q1 * p, v = Math.max(v0, v1);
        if (!(v < CFG.valueCap) || v < CFG.dust) continue;
        const k = key(t);
        add(startQty, k, q0); add(endQty, k, q1);
        priceOf[k] = p;
        symbolOf[k] = symbolFor(t);
        startValue += v0; endValue += v1;
      }
      // Native coin
      const n0 = snap.nativeStart / 1e18, n1 = snap.nativeEnd / 1e18;
      add(startQty, nativeKey, n0); add(endQty, nativeKey, n1);
      priceOf[nativeKey] = nativePrice;
      symbolOf[nativeKey] = CFG.nativeSymbol;
      startValue += n0 * nativePrice; endValue += n1 * nativePrice;

      // Staked HEX (principal only, so yield shows up when a stake ends)
      add(startQty, CFG.hex, snap.stakedStart); add(endQty, CFG.hex, snap.stakedEnd);
      if (hexPrice > 0) priceOf[CFG.hex] = hexPrice;
      symbolOf[CFG.hex] = 'HEX';
      startValue += snap.stakedStart * hexPrice; endValue += snap.stakedEnd * hexPrice;

      // A V2 pair minted this year that the wallet didn't hold on 1 January is new.
      for (const p of w.mintedPairs) if (!(snap.pairStart[p] > 0)) newLP++;
    }
    if (!endKnown) throw new Error('Could not read balances from the PulseChain RPCs. Try again in a minute.');

    // Coins worth showing: priced, worth $10 at one end, ranked by value.
    let stacks = [];
    for (const [k, end] of Object.entries(endQty)) {
      const start = startQty[k] || 0, price = priceOf[k] || 0, weight = Math.max(start, end) * price;
      const symbol = symbolOf[k];
      if (!(price > 0) || weight < CFG.listMin || !symbol || STABLES.has(symbol.toUpperCase())) continue;
      stacks.push({ symbol, start, end, weight });
    }
    const bySymbol = {};
    for (const s of stacks) {
      const g = bySymbol[s.symbol] || (bySymbol[s.symbol] = { symbol: s.symbol, start: 0, end: 0, weight: 0 });
      g.start += s.start; g.end += s.end; g.weight += s.weight;
    }
    stacks = Object.values(bySymbol).sort((a, b) => b.weight - a.weight)
      .map((s) => ({ ...s, changePercent: s.start > 0 ? (s.end - s.start) / s.start * 100 : null }));

    let top = null;
    for (const [s, m] of Object.entries(buyMonths)) {
      if (!top || m.size > top[1].size || (m.size === top[1].size && s < top[0])) top = [s, m];
    }

    const r = {
      year, periodEnd, walletCount: wallets.length, monthsElapsed,
      stackStartValue: startKnown ? startValue : null,
      stackEndValue: endValue,
      stacks,
      transactions: txCount, activeDays: days.size, monthly, swaps, cashOuts,
      topBuySymbol: top ? top[0] : null, topBuyMonths: top ? top[1].size : 0,
      topBuySold: top ? soldSymbols.has(top[0]) : false,
      stakesStarted, stakesEnded, newLPPositions: newLP, liquidityAdds: lpAdds, capped, limited, readFailed,
      // Average stake length per chain, days; the app splits PulseChain and Ethereum.
      stakeLengths: (newStakes.count || activeStakes.count) ? [{
        symbol: 'HEX',
        newCount: newStakes.count, newAverage: newStakes.count ? Math.round(newStakes.days / newStakes.count) : null,
        activeCount: activeStakes.count, activeAverage: activeStakes.count ? Math.round(activeStakes.days / activeStakes.count) : null,
      }] : [],
      // Transactions and monthly are exact even when capped (read from nonces).
      transactionsExact: txExact, sentFromNonce,
      startBlock, endBlock,
    };
    r.stackChangePercent = stackChangePercent(r);
    r.startedFromZero = startedFromZero(r);
    r.story = storyOf(r);
    progress({ fraction: 1, detail: 'Done' });
    return r;
  }

  // ---------- card text (RollupText) ----------
  function percent(v) {
    const digits = Math.abs(v) < 10 ? 1 : 0;
    return new Intl.NumberFormat('en', { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: 'always' }).format(v / 100);
  }
  function multiple(m) {
    const digits = m < 10 ? 1 : 0;
    return '×' + new Intl.NumberFormat('en', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(m);
  }
  /** A change in percent, or as a multiple once it passes +300%. */
  function change(v) { return v >= 300 ? multiple(1 + v / 100) : percent(v); }
  const count = (n) => new Intl.NumberFormat('en').format(n);
  const inDays = (n) => `${count(n)} ${n === 1 ? 'day' : 'days'}`;

  /** Every string the card shows. Percentages and counts only. */
  function text(r) {
    const plus = r.capped ? '+' : '';
    // Transactions stay exact when a nonce stood in for a cut-short list.
    const txPlus = r.capped && !r.transactionsExact ? '+' : '';
    const topBuy = r.topBuySymbol || '';
    const t = { year: String(r.year), title: 'Year in Review' };
    const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
    t.period = `${dateFmt.format(new Date(r.year, 0, 1))} – ${dateFmt.format(r.periodEnd)}`;

    switch (r.story) {
      case 'heldSteady': t.storyTitle = 'Diamond Hands'; t.storyLine = 'Not a single move all year'; break;
      case 'steadyBuyer':
        t.storyTitle = 'Steady Buyer';
        t.storyLine = `Bought ${topBuy} in ${r.topBuyMonths} of ${r.monthsElapsed} months` + (r.topBuySold ? '' : ', never sold');
        break;
      case 'trader': t.storyTitle = 'Active Trader'; t.storyLine = `Swaps this year: ${count(r.swaps)}${plus}`; break;
      case 'liquidity':
        t.storyTitle = 'Liquidity Provider';
        t.storyLine = r.newLPPositions > 0 ? `New LP positions: ${r.newLPPositions}` : `Times you added liquidity: ${count(r.liquidityAdds)}${plus}`;
        break;
      case 'staker': t.storyTitle = 'Staker'; t.storyLine = `New HEX stakes: ${r.stakesStarted}`; break;
      case 'stacker':
        t.storyTitle = 'Stacker';
        t.storyLine = r.cashOuts === 0 ? 'Grew your stack without cashing out' : 'Grew your stack';
        break;
      case 'tookProfits': t.storyTitle = 'Took Profits'; t.storyLine = `Times you cashed out: ${r.cashOuts}`; break;
      case 'busy': t.storyTitle = 'Always On'; t.storyLine = `Transactions this year: ${count(r.transactions)}${txPlus}`; break;
      default: t.storyTitle = 'Holder'; t.storyLine = 'Kept your stack through the year';
    }

    t.heroLabel = 'Your stack';
    t.heroNote = "Coins you hold, at today's prices";
    if (r.stackChangePercent != null) t.heroValue = change(r.stackChangePercent);
    else if (r.startedFromZero) t.heroValue = 'New';
    else t.heroValue = '–';

    // What else they did, the story's own number left out.
    const stats = [];
    if (r.stakesStarted > 0 && r.story !== 'staker') {
      stats.push({ label: 'New HEX stakes', value: count(r.stakesStarted), note: r.stakesEnded > 0 ? `${r.stakesEnded} ended` : null });
    } else if (r.stakesEnded > 0 && r.stakesStarted === 0) {
      stats.push({ label: 'HEX stakes ended', value: count(r.stakesEnded), note: null });
    }
    for (const s of r.stakeLengths || []) {
      if (s.newAverage != null) {
        const sameSet = s.activeAverage == null || (s.activeCount === s.newCount && s.activeAverage === s.newAverage);
        stats.push({ label: `Avg new ${s.symbol} stake`, value: inDays(s.newAverage), note: sameSet ? null : `All active: ${inDays(s.activeAverage)}` });
      } else if (s.activeAverage != null) {
        stats.push({ label: `Avg ${s.symbol} stake`, value: inDays(s.activeAverage), note: null });
      }
    }
    if (r.newLPPositions > 0 && r.story !== 'liquidity') stats.push({ label: 'New LP positions', value: count(r.newLPPositions), note: null });
    if (r.topBuyMonths >= 2 && r.story !== 'steadyBuyer') stats.push({ label: `Months buying ${topBuy}`, value: `${r.topBuyMonths}/${r.monthsElapsed}`, note: null });
    if (r.swaps > 0 && r.story !== 'trader') stats.push({ label: 'Swaps', value: count(r.swaps) + plus, note: null });
    for (const coin of r.stacks.slice(0, 2)) {
      let value;
      if (coin.changePercent != null) {
        if (Math.abs(coin.changePercent) < 0.5) continue;
        value = change(coin.changePercent);
      } else if (coin.end > 0) value = 'New';
      else continue;
      stats.push({ label: `${coin.symbol} stack`, value, note: null });
    }
    // A nonce count says how many, not on which days: active days would be
    // a small fraction of the truth, so the exact count goes on the card.
    if (r.sentFromNonce) {
      if (r.story !== 'busy') stats.push({ label: 'Transactions', value: count(r.transactions) + txPlus, note: null });
    } else if (r.activeDays > 0) {
      stats.push({ label: 'Active days', value: count(r.activeDays) + plus, note: null });
    }
    t.stats = stats;
    t.monthly = r.monthly;
    t.monthsElapsed = r.monthsElapsed;
    t.monthLetters = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    t.ctaTitle = 'Make your own Year in Review';
    t.ctaSubtitle = 'chingching.xyz/year';
    return t;
  }

  const api = { stakeDaysOf, inDays, CFG, reviewYear, build, text, percent, multiple, change, isAddress, short, encAggregate3, decAggregate3, parseDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YearCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

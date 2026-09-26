/* LP Yield core: V3 position maths, ABI encoding and chain reads for 9mm,
 * LibertySwap and Switch on PulseChain, and Uniswap V3 on Ethereum.
 *
 * Adding a chain: an entry in CHAINS, a DEX in DEXES naming it, and a fetcher
 * in FETCHERS that returns rows in the 9mm subgraph shape (see fetchUniswapV3).
 *
 * Kept free of DOM so it can be exercised from Node against a forked chain.
 * The formulas mirror the app's WalletCalcs.swift (computeV3TokenAmounts,
 * computePoolFeeAPR, fetchUnclaimedV3Fees) so the page and the app agree.
 */
(function (root) {
  'use strict';

  /**
   * Chains. `rpcs` are browser-reachable (CORS) and batch-capable; the first two
   * are rotated between. `archiveRpcs` serve historical state, used for the
   * 24h fee-growth APR where there is no subgraph. Measured 2026-09-25.
   */
  const CHAINS = {
    pulsechain: {
      key: 'pulsechain', id: 369, hex: '0x171', name: 'PulseChain', native: 'PLS',
      // Order measured 2026-09-24: publicnode and g4mm4 answer a 25-call batch
      // in ~300 ms; rpc.pulsechain.com takes 4 s for 10 and times out at 25.
      rpcs: ['https://pulsechain-rpc.publicnode.com', 'https://rpc-pulsechain.g4mm4.io', 'https://rpc.pulsechain.com'],
      archiveRpcs: ['https://rpc-pulsechain.g4mm4.io', 'https://rpc.pulsechain.com'],
      explorerTx: 'https://otter.pulsechain.com/tx/',
      // Native PLS always left in the wallet after gas, so it can pay for
      // whatever it does next. The page never spends native PLS otherwise:
      // every tx has value 0 and fees arrive (and go back in) as WPLS.
      nativeReserve: 1000,
      // Read from each PulseChain position manager's WETH9(), 2026-09-25.
      wrapped: '0xa1077a294dde1b09bb078844df40758a5d0f9a27',
      addChain: { chainName: 'PulseChain', nativeCurrency: { name: 'Pulse', symbol: 'PLS', decimals: 18 },
        rpcUrls: ['https://rpc.pulsechain.com'], blockExplorerUrls: ['https://otter.pulsechain.com'] },
    },
    ethereum: {
      key: 'ethereum', id: 1, hex: '0x1', name: 'Ethereum', native: 'ETH',
      // Measured 2026-09-25 for CORS, a 25-call eth_call batch and historical
      // state: publicnode (CORS *, batch, no history), mevblocker and blastapi
      // (CORS for our origin, batch, history). Rejected: drpc's free plan caps
      // batches at 3 and answers bigger ones with an error per item (which read
      // as success until rpcBatchOnce learned to reject that), flashbots caps
      // batches too, 1rpc 301s POSTs, llamarpc/merkle/payload send no CORS.
      // drpc stays as the last archive node: the archive read is one call.
      rpcs: ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://eth-mainnet.public.blastapi.io'],
      archiveRpcs: ['https://rpc.mevblocker.io', 'https://eth-mainnet.public.blastapi.io', 'https://eth.drpc.org'],
      multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
      explorerTx: 'https://etherscan.io/tx/',
      dexscreenerSlug: 'ethereum',
      // Read from the position manager's WETH9()/factory(), not recalled.
      wrapped: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      blocksPerDay: 7200,
    },
  };
  const chainOf = (key) => CHAINS[key] || CHAINS.pulsechain;

  const CFG = {
    // PulseChain aliases kept for callers written before multi-chain.
    chainId: 369,
    chainHex: '0x171',
    subgraph: 'https://info-api.9mm.pro/subgraphs/name/pulsechain/9mm-v3',
    // LibertySwap's Goldsky subgraph needs a key, so it goes through our Worker.
    lbsProxy: 'https://pnj.chingching.xyz',
    switchSubgraph: 'https://api.goldsky.com/api/public/project_cme16kgb0ib7s01unc3juduwk/subgraphs/analytics/v2.2.0/gn',
    rpcs: CHAINS.pulsechain.rpcs,
    explorerTx: CHAINS.pulsechain.explorerTx,
    dexscreener: 'https://api.dexscreener.com/tokens/v1/',
  };

  /**
   * Each DEX's NonfungiblePositionManager. All three take the same collect,
   * increaseLiquidity and multicall calldata (Switch is an Algebra fork, but
   * its structs, positions() offsets for token0/token1 and increaseLiquidity
   * return match Uniswap's); each was compounded on an anvil fork 2026-09-24.
   * Keys match wallet/config.swift's v3PositionManager(forDex:). Uniswap V3's
   * manager answers name() "Uniswap V3 Positions NFT-V1"; its factory() and
   * WETH9() were read on-chain 2026-09-25.
   */
  const DEXES = {
    '9mm': { label: '9mm', chain: 'pulsechain', nfpm: '0xcc05bf158202b4f461ede8843d76dcd7bbad07f2' },
    lbs: { label: 'LibertySwap', chain: 'pulsechain', nfpm: '0x19b1347900840e7a299f339868881750918fad91' },
    // Algebra names its unwrap differently; unwrapWETH9 reverts on it (simulated).
    switch: { label: 'Switch', chain: 'pulsechain', nfpm: '0xbfd64d5f12ec1389460d02861cbbb939b99230c6',
      unwrap: 'unwrapWNativeToken' },
    univ3: { label: 'Uniswap V3', chain: 'ethereum', nfpm: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
      factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984' },
    // 9mm's Ethereum deployment (a PancakeSwap V3 fork, same interfaces as
    // Uniswap for everything read here). Manager found as the owner of every
    // mint in the ethereum/9mm-v3 subgraph, then verified on-chain 2026-09-25:
    // name() "NineMM V3 Positions NFT-V1", factory() matches the subgraph's
    // factory, WETH9() is WETH. Read on-chain rather than from that subgraph:
    // it silently drops scalar tickLower/tickUpper (only { tickIdx } works)
    // and its 80 thin pools make derivedUSD untrustworthy.
    '9mmeth': { label: '9mm', chain: 'ethereum', nfpm: '0x290a0376177a172911baba25f6c15e1748f4ae47',
      factory: '0xcc941d37297534696e963fb624b7593c33afdd7f' },
  };

  // Selectors, computed with `cast sig`, not recalled.
  const SEL = {
    collect: '0xfc6f7865',   // collect((uint256,address,uint128,uint128))
    increase: '0x219f5d17',  // increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))
    multicall: '0xac9650d8', // multicall(bytes[])
    positions: '0x99fbab88', // positions(uint256)
    approve: '0x095ea7b3',   // approve(address,uint256)
    allowance: '0xdd62ed3e', // allowance(address,address)
    balanceOf: '0x70a08231', // balanceOf(address)
    liquidity: '0x1a686502', // liquidity()
    tokenOfOwnerByIndex: '0x2f745c59', // tokenOfOwnerByIndex(address,uint256)
    getPool: '0x1698ee82',   // getPool(address,address,uint24)
    slot0: '0x3850c7bd',     // slot0()
    feeGrowth0: '0xf3058399', // feeGrowthGlobal0X128()
    feeGrowth1: '0x46141319', // feeGrowthGlobal1X128()
    symbol: '0x95d89b41',    // symbol()
    decimals: '0x313ce567',  // decimals()
    aggregate3: '0x82ad56cb', // aggregate3((address,bool,bytes)[])
    unwrapWETH9: '0x49404b7c',        // unwrapWETH9(uint256,address): Uniswap/Pancake managers
    unwrapWNativeToken: '0x69bc35b2', // unwrapWNativeToken(uint256,address): Algebra (Switch)
    sweepToken: '0xdf2ab5bb',         // sweepToken(address,uint256,address)
  };

  const MAX128 = (1n << 128n) - 1n;
  const MAX256 = (1n << 256n) - 1n;
  const Q96 = 2 ** 96;

  const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);

  // ---------- ABI ----------
  const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);
  const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
  const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
  const pad32 = (hex) => hex + '0'.repeat((64 - (hex.length % 64)) % 64);

  function encCollect(tokenId, recipient) {
    return SEL.collect + word(tokenId) + addrWord(recipient) + word(MAX128) + word(MAX128);
  }

  function encIncrease(tokenId, amount0, amount1, min0, min1, deadline) {
    return SEL.increase + word(tokenId) + word(amount0) + word(amount1) + word(min0) + word(min1) + word(deadline);
  }

  /** multicall(bytes[]): head offset, length, per-item offsets, then length-prefixed items. */
  function encMulticall(calls) {
    const items = calls.map(strip);
    const n = items.length;
    let head = '', tail = '', off = 32 * n;
    for (const it of items) {
      const padded = pad32(it);
      head += word(off);
      tail += word(it.length / 2) + padded;
      off += 32 + padded.length / 2;
    }
    return SEL.multicall + word(32) + word(n) + head + tail;
  }

  /** Decode a bytes[] return value into hex strings (no 0x). */
  function decBytesArray(hex) {
    hex = strip(hex);
    const at = (byte) => BigInt('0x' + hex.slice(byte * 2, byte * 2 + 64));
    const base = Number(at(0));
    const n = Number(at(base));
    const start = base + 32;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = start + Number(at(start + 32 * i));
      const len = Number(at(p));
      out.push(hex.slice((p + 32) * 2, (p + 32 + len) * 2));
    }
    return out;
  }

  const wordsOf = (hex) => {
    hex = strip(hex);
    const out = [];
    for (let i = 0; i + 64 <= hex.length; i += 64) out.push(BigInt('0x' + hex.slice(i, i + 64)));
    return out;
  };

  /** Pull the revert reason out of a JSON-RPC error, for messages a person can act on. */
  function revertReason(err) {
    if (!err) return 'unknown error';
    const data = typeof err.data === 'string' ? err.data : (err.data && err.data.data) || '';
    if (data.startsWith('0x08c379a0') && data.length >= 138) {
      try {
        const body = data.slice(10);
        const len = Number(BigInt('0x' + body.slice(64, 128)));
        const bytes = body.slice(128, 128 + len * 2).match(/../g) || [];
        return 'reverted: ' + bytes.map((b) => String.fromCharCode(parseInt(b, 16))).join('');
      } catch (_) { /* fall through */ }
    }
    return err.message || String(err);
  }

  // ---------- transport ----------
  async function fetchT(url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctl.signal }); }
    catch (e) {
      if (e && e.name === 'AbortError') throw new Error(new URL(url).host + ' timed out');
      throw e;
    } finally { clearTimeout(t); }
  }

  async function rpcBatchOnce(url, reqs) {
    const body = reqs.map((r, i) => ({ jsonrpc: '2.0', id: i, method: r.method, params: r.params }));
    const res = await fetchT(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, 12000);
    if (!res.ok) throw new Error(url + ' HTTP ' + res.status);
    const arr = await res.json();
    if (!Array.isArray(arr)) throw new Error(url + ' returned a non-batch reply');
    const out = new Array(reqs.length);
    for (const r of arr) out[r.id] = r;
    if (out.some((r) => !r)) throw new Error(url + ' dropped items from the batch');
    // A node that refuses the batch itself (size caps) can answer with an error
    // per item instead of an HTTP error. Every item failing for a reason other
    // than a revert is the node, not the calls, so fail over.
    if (reqs.length > 1 && out.every((r) => r.error)
        && !out.some((r) => /revert/i.test(String(r.error && r.error.message)))) {
      throw new Error(url + ' rejected the batch: ' + String(out[0].error.message || '').slice(0, 80));
    }
    return out;
  }

  /**
   * JSON-RPC batch, hedged across nodes: if one hasn't answered in 2.5 s (or
   * fails), the same batch goes to the next and the first good answer wins.
   * In the browser a single stalled request otherwise held a 256-position
   * refresh for 12 s. Reads only, so a duplicate request is harmless.
   * Per-item errors (reverts) are returned, not thrown.
   */
  function rpcBatch(reqs, rpcs = CFG.rpcs, hedgeMs = 2500) {
    return new Promise((resolve, reject) => {
      let started = 0, failed = 0, done = false, lastErr, timer;
      const launch = () => {
        if (done || started >= rpcs.length) return;
        const url = rpcs[started++];
        clearTimeout(timer);
        timer = setTimeout(launch, hedgeMs);
        rpcBatchOnce(url, reqs).then((out) => {
          if (done) return;
          done = true; clearTimeout(timer); resolve(out);
        }, (e) => {
          lastErr = e; failed++;
          if (done) return;
          if (failed >= rpcs.length) { done = true; clearTimeout(timer); reject(lastErr); }
          else launch();
        });
      };
      launch();
    });
  }

  /**
   * Split a large batch into chunks, a few in flight at a time. Each chunk
   * starts on a different RPC (rotating) so no single node takes all the load,
   * and still fails over through the rest. A chunk that fails everywhere
   * yields per-item errors instead of sinking the whole batch.
   */
  async function rpcBatchChunked(reqs, size = 25, parallel = 3, rpcs = CFG.rpcs) {
    const chunks = [];
    for (let i = 0; i < reqs.length; i += size) chunks.push(reqs.slice(i, i + size));
    const results = new Array(chunks.length);
    let next = 0;
    async function worker() {
      while (next < chunks.length) {
        const i = next++;
        const k = i % Math.min(2, rpcs.length); // rotate over the two fast nodes
        try {
          results[i] = await rpcBatch(chunks[i], rpcs.slice(k).concat(rpcs.slice(0, k)));
        } catch (e) {
          results[i] = chunks[i].map(() => ({ error: { message: e.message || String(e) } }));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, worker));
    return results.flat();
  }

  async function rpcCall(method, params, rpcs) {
    const [r] = await rpcBatch([{ method, params }], rpcs);
    if (r.error) { const e = new Error(revertReason(r.error)); e.rpc = r.error; throw e; }
    return r.result;
  }

  const ethCall = (to, data, from, rpcs) =>
    rpcCall('eth_call', [from ? { from, to, data } : { to, data }, 'latest'], rpcs);

  async function gql(query, url = CFG.subgraph) {
    const res = await fetchT(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
    }, 25000);
    const host = new URL(url).host;
    if (!res.ok) throw new Error(host + ' HTTP ' + res.status);
    const j = await res.json();
    if (j.errors && j.errors.length) throw new Error(host + ': ' + j.errors[0].message);
    return j.data;
  }

  // ---------- reads ----------
  // No nested poolDayData here: the 9mm endpoint answers "Unexpected error." to
  // a positions query with per-position day data once a wallet holds ~30+
  // positions. Day data comes from one flat poolDayDatas query instead.
  const POSITION_FIELDS = `
    id owner liquidity tickLower tickUpper
    pool { id feeTier tick sqrtPrice liquidity
      token0 { id symbol decimals derivedUSD }
      token1 { id symbol decimals derivedUSD }
    }`;

  // One row per block in which a position changed (add, remove, collect) or
  // changed hands, with the running totals in whole tokens at that point.
  const TOTAL_FIELDS = 'depositedToken0 depositedToken1 withdrawnToken0 withdrawnToken1 collectedFeesToken0 collectedFeesToken1';
  const SNAPSHOT_FIELDS = 'owner blockNumber timestamp liquidity ' + TOTAL_FIELDS;

  /**
   * The two newest poolDayData rows per pool from the last week, newest first,
   * which is what the app's nested `poolDayData(first: 2)` returns.
   */
  async function fetchPoolDays(poolIds) {
    const ids = [...new Set(poolIds.map((x) => x.toLowerCase()))].filter(isAddress);
    const since = Math.floor(Date.now() / 86400000) * 86400 - 7 * 86400;
    const byPool = {};
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const d = await gql(`{poolDayDatas(first: 1000, orderBy: date, orderDirection: desc,
        where: { pool_in: [${chunk.map((x) => `"${x}"`).join(',')}], date_gte: ${since} }) { date feesUSD tvlUSD pool { id } }}`);
      for (const row of d.poolDayDatas) {
        const k = row.pool.id.toLowerCase();
        (byPool[k] = byPool[k] || []).push(row);
      }
    }
    for (const k of Object.keys(byPool)) byPool[k] = byPool[k].sort((a, b) => b.date - a.date).slice(0, 2);
    return byPool;
  }

  /**
   * 9mm: every open position for the given owners, paged with id_gt because
   * the endpoint silently caps unpaged queries (see the subgraph pagination
   * lesson), with each pool's recent day data attached as pool.poolDayData.
   */
  async function fetch9mm(owners) {
    const ownersArg = owners.map((o) => `"${o}"`).join(',');
    const all = [];
    let last = null, plsUsd = 0;
    for (let page = 0; page < 20; page++) {
      const idFilter = last ? `, id_gt: "${last}"` : '';
      const q = `{
        bundles(first: 1) { ethPriceUSD }
        positions(first: 1000, orderBy: id, orderDirection: asc,
          where: { owner_in: [${ownersArg}], liquidity_gt: "0"${idFilter} }) { ${POSITION_FIELDS} ${TOTAL_FIELDS} }
      }`;
      const d = await gql(q);
      if (d.bundles && d.bundles[0]) plsUsd = Number(d.bundles[0].ethPriceUSD) || plsUsd;
      all.push(...d.positions);
      if (d.positions.length < 1000) break;
      last = d.positions[d.positions.length - 1].id;
    }
    const [days] = await Promise.all([
      all.length ? fetchPoolDays(all.map((p) => p.pool.id)) : {},
      attachHistory(all, owners).catch(() => { /* no history: IL shows as unknown */ }),
    ]);
    for (const p of all) p.pool.poolDayData = days[p.pool.id.toLowerCase()] || [];
    return { positions: all, plsUsd };
  }

  /**
   * Every snapshot of each position, oldest first. The subgraph filters
   * snapshots by one position only, so 50 positions go in one request as
   * aliases (128 positions, 1,633 snapshots: 2 s). A position with 1,000+
   * snapshots is paged on by block.
   */
  async function fetchSnapshots(ids) {
    const out = {};
    const one = (id, after) => `p${id}: positionSnapshots(first: 1000, orderBy: blockNumber, orderDirection: asc, `
      + `where: { position: "${id}"${after ? `, blockNumber_gt: "${after}"` : ''} }) { ${SNAPSHOT_FIELDS} }`;
    const chunks = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    let next = 0;
    async function worker() {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        const d = await gql(`{ ${chunk.map((id) => one(id)).join(' ')} }`);
        for (const id of chunk) out[id] = d['p' + id] || [];
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));
    for (const id of ids) {
      while (out[id].length && out[id].length % 1000 === 0) {
        const more = (await gql(`{ ${one(id, out[id][out[id].length - 1].blockNumber)} }`))['p' + id] || [];
        if (!more.length) break;
        out[id].push(...more);
      }
    }
    return out;
  }

  /**
   * The stretch of a position's history that belongs to the tracked wallets:
   * from its mint, or from when one of them received it. A move between two
   * tracked wallets doesn't restart it. #154598 is why: minted and 99% withdrawn
   * by another wallet, then sent on, its lifetime totals were someone else's.
   */
  function tenureOf(snaps, owners) {
    if (!snaps || !snaps.length) return null;
    let start = snaps.length;
    while (start > 0 && owners.has(String(snaps[start - 1].owner).toLowerCase())) start--;
    if (start === snaps.length) return null; // the newest snapshot isn't ours yet (indexing lag)
    return { start, received: start > 0, since: Number(snaps[start].timestamp), block: Number(snaps[start].blockNumber) };
  }

  /**
   * The snapshot list can trail the position: #164664's newest add never got a
   * snapshot (last one 5.861e21 liquidity, position 5.875e21), so its tokens
   * were missing from "held instead" while its liquidity counted in the value,
   * and IL read +$98. When the newest snapshot disagrees with the position's
   * own totals, those totals become one more step.
   */
  function reconcile(p, snaps) {
    if (!snaps || !snaps.length) return snaps || null;
    const last = snaps[snaps.length - 1];
    const keys = ['liquidity'].concat(TOTAL_FIELDS.split(' '));
    if (keys.every((k) => p[k] == null || num(p[k]) === num(last[k]))) return snaps;
    const fix = { ...last, owner: p.owner };
    for (const k of keys) if (p[k] != null) fix[k] = p[k];
    return snaps.concat([fix]);
  }

  /**
   * Snapshots and tenure on each 9mm row, plus, for a received position, what
   * it held at that moment: its liquidity then, at the pool price read from an
   * archive node at that block (the subgraph ignores block-pinned queries).
   */
  async function attachHistory(positions, owners) {
    if (!positions.length) return;
    const tracked = new Set(owners.map((o) => o.toLowerCase()));
    const snaps = await fetchSnapshots(positions.map((p) => String(p.id)));
    const received = [];
    for (const p of positions) {
      p.snapshots = reconcile(p, snaps[String(p.id)]);
      p.tenure = tenureOf(p.snapshots, tracked);
      if (p.tenure && p.tenure.received) received.push(p);
    }
    if (!received.length) return;
    const chain = CHAINS.pulsechain;
    const res = await rpcBatchChunked(received.map((p) => ({
      method: 'eth_call', params: [{ to: p.pool.id, data: SEL.slot0 }, '0x' + p.tenure.block.toString(16)],
    })), 25, 3, chain.archiveRpcs);
    received.forEach((p, i) => {
      const r = res[i];
      if (!r || r.error || !r.result || r.result === '0x') return;
      const w = wordsOf(r.result);
      const { a0, a1 } = positionAmounts(p.snapshots[p.tenure.start].liquidity, w[0].toString(),
        Number(BigInt.asIntN(24, w[1])), num(p.tickLower), num(p.tickUpper));
      p.tenure.startAmounts = { a0: a0 / 10 ** num(p.pool.token0.decimals), a1: a1 / 10 ** num(p.pool.token1.decimals) };
    });
  }

  /** Active liquidity per pool, read on-chain: keyed by lowercased pool id. */
  async function fetchPoolLiquidity(poolIds, rpcs) {
    const ids = [...new Set(poolIds.map((x) => x.toLowerCase()))].filter(isAddress);
    const res = await rpcBatchChunked(ids.map((id) => ({ method: 'eth_call', params: [{ to: id, data: SEL.liquidity }, 'latest'] })), 25, 3, rpcs);
    const out = {};
    ids.forEach((id, i) => { const r = res[i]; if (r && r.result && strip(r.result).length >= 64) out[id] = wordsOf(r.result)[0].toString(); });
    return out;
  }

  /**
   * LibertySwap, through our Worker (one owner per request, 200 positions max,
   * already in the 9mm field shape with day data nested; Goldsky handles that
   * fine). The Worker has no owner or pool liquidity fields, so the owner is
   * stamped here and active liquidity is read from each pool on-chain rather
   * than changing and redeploying the Worker.
   */
  async function fetchLbs(owners, rpcs) {
    const all = [];
    await Promise.all(owners.map(async (owner) => {
      const res = await fetchT(`${CFG.lbsProxy}/lbs/positions?owner=${owner}`, { method: 'GET' }, 25000);
      if (!res.ok) throw new Error('LibertySwap HTTP ' + res.status);
      const j = await res.json();
      if (j.error) throw new Error('LibertySwap: ' + j.error);
      for (const p of j.positions || []) all.push({ ...p, owner });
    }));
    const liq = all.length ? await fetchPoolLiquidity(all.map((p) => p.pool.id), rpcs) : {};
    for (const p of all) p.pool.liquidity = liq[p.pool.id.toLowerCase()] || '0';
    return { positions: all };
  }

  /**
   * Switch (Algebra fork) from its public Goldsky subgraph. Reshaped into the
   * 9mm field names the way the app's fetchSwitchLPPositions does: ticks come
   * as { tickIdx }, the dynamic `fee` stands in for feeTier, and prices are
   * derivedMatic (PLS here) times the bundle's PLS price.
   */
  async function fetchSwitch(owners) {
    const ownersArg = owners.map((o) => `"${o}"`).join(',');
    const all = [];
    let last = null, plsUsd = 0;
    for (let page = 0; page < 20; page++) {
      const idFilter = last ? `, id_gt: "${last}"` : '';
      const d = await gql(`{
        bundles(first: 1) { maticPriceUSD }
        positions(first: 1000, orderBy: id, orderDirection: asc,
          where: { owner_in: [${ownersArg}], liquidity_gt: "0"${idFilter} }) {
          id owner liquidity tickLower { tickIdx } tickUpper { tickIdx }
          pool { id fee tick sqrtPrice liquidity
            token0 { id symbol decimals derivedMatic }
            token1 { id symbol decimals derivedMatic }
            poolDayData(first: 2, orderBy: date, orderDirection: desc) { date feesUSD tvlUSD }
          }
        }
      }`, CFG.switchSubgraph);
      if (d.bundles && d.bundles[0]) plsUsd = Number(d.bundles[0].maticPriceUSD) || plsUsd;
      all.push(...d.positions);
      if (d.positions.length < 1000) break;
      last = d.positions[d.positions.length - 1].id;
    }
    const usd = (t) => ({ id: t.id, symbol: t.symbol, decimals: t.decimals, derivedUSD: String(num(t.derivedMatic) * plsUsd) });
    return {
      plsUsd,
      positions: all.map((p) => ({
        ...p,
        tickLower: p.tickLower && p.tickLower.tickIdx,
        tickUpper: p.tickUpper && p.tickUpper.tickIdx,
        pool: { ...p.pool, feeTier: p.pool.fee, token0: usd(p.pool.token0), token1: usd(p.pool.token1) },
      })),
    };
  }

  // ---------- Multicall3 (one eth_call for many reads) ----------
  /** aggregate3 calldata for [[target, data], ...], every call allowed to fail. */
  function encAggregate3(list) {
    const n = list.length;
    let head = '', tail = '', off = 32 * n;
    for (const [target, data] of list) {
      const d = strip(data), padded = pad32(d);
      const el = addrWord(target) + word(1) + word(96) + word(d.length / 2) + padded;
      head += word(off);
      tail += el;
      off += el.length / 2;
    }
    return SEL.aggregate3 + word(32) + word(n) + head + tail;
  }

  /** aggregate3's (bool success, bytes returnData)[] as hex strings, null on failure. */
  function decAggregate3(hex) {
    hex = strip(hex);
    const at = (byte) => BigInt('0x' + hex.slice(byte * 2, byte * 2 + 64));
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

  /** Many reads at one block through Multicall3, 100 per call. */
  async function multiRead(list, chain, block, rpcs) {
    const out = [];
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const res = await rpcCall('eth_call', [{ to: chain.multicall3, data: encAggregate3(chunk) }, block], rpcs);
      out.push(...decAggregate3(res));
    }
    return out;
  }

  // ---------- Uniswap-V3-style DEXes read on-chain (Uniswap V3 and 9mm on Ethereum) ----------
  const toAddr = (w) => '0x' + w.toString(16).padStart(40, '0');

  /** ERC-20 symbol as a string, or as bytes32 for the old tokens (MKR). */
  function decodeSymbol(hex) {
    const h = strip(hex || '');
    if (h.length < 64) return '?';
    const ascii = (x) => (x.match(/../g) || []).map((b) => parseInt(b, 16)).filter((c) => c >= 32 && c < 127)
      .map((c) => String.fromCharCode(c)).join('');
    if (h.length >= 192 && BigInt('0x' + h.slice(0, 64)) === 32n) {
      const len = Number(BigInt('0x' + h.slice(64, 128)));
      return ascii(h.slice(128, 128 + len * 2)) || '?';
    }
    return ascii(h.slice(0, 64)) || '?';
  }

  /** Batch eth_calls; returns result hex or null per call. */
  async function calls(list, rpcs, block = 'latest') {
    if (!list.length) return [];
    const res = await rpcBatchChunked(list.map(([to, data]) => ({ method: 'eth_call', params: [{ to, data }, block] })), 25, 3, rpcs);
    return res.map((r) => (r && !r.error && r.result && r.result !== '0x' ? r.result : null));
  }

  /**
   * USD prices from DexScreener, per token: the deepest pair quoted in a
   * trusted token when there is one, else the deepest pair. The ENJ lesson: a
   * single pair quoted in something odd can carry a wildly wrong USD price.
   */
  async function dexScreenerPrices(addresses, slug) {
    const trusted = new Set(['WETH', 'ETH', 'USDC', 'USDT', 'DAI', 'WBTC']);
    const out = {};
    const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
    for (let i = 0; i < unique.length; i += 30) {
      const chunk = unique.slice(i, i + 30);
      const res = await fetchT(CFG.dexscreener + slug + '/' + chunk.join(','), {}, 15000);
      if (!res.ok) throw new Error('DexScreener HTTP ' + res.status);
      const pairs = await res.json();
      const best = {};
      for (const pair of Array.isArray(pairs) ? pairs : []) {
        const base = (pair.baseToken && pair.baseToken.address || '').toLowerCase();
        const price = num(pair.priceUsd), liq = num(pair.liquidity && pair.liquidity.usd);
        if (!chunk.includes(base) || !(price > 0)) continue;
        const isTrusted = trusted.has(String(pair.quoteToken && pair.quoteToken.symbol || '').toUpperCase());
        const cur = best[base];
        if (!cur || (isTrusted && !cur.trusted) || (isTrusted === cur.trusted && liq > cur.liq)) {
          best[base] = { price, liq, trusted: isTrusted };
        }
      }
      for (const [a, b] of Object.entries(best)) out[a] = b.price;
    }
    return out;
  }

  /**
   * Uniswap V3 positions read from the chain: enumerate each owner's NFTs,
   * read positions(), find each pool via the factory, then slot0, liquidity,
   * token metadata and prices. Rows come back in the 9mm subgraph shape.
   *
   * APR: no subgraph means no poolDayData, so the position's own daily fees
   * come from the pool's feeGrowthGlobal over the last ~24h (read at an old
   * block from the archive RPC) times the position's liquidity. That is what
   * the position earned per day if it sat in range throughout.
   */
  async function fetchUniswapV3(owners, _rpcs, dexKey = 'univ3') {
    const dex = DEXES[dexKey], chain = chainOf(dex.chain), rpcs = chain.rpcs;
    const MAX_PER_OWNER = 200;

    const balances = await calls(owners.map((o) => [dex.nfpm, SEL.balanceOf + addrWord(o)]), rpcs);
    const idCalls = [], idOwner = [];
    owners.forEach((o, i) => {
      const n = Math.min(Number(balances[i] ? wordsOf(balances[i])[0] : 0n), MAX_PER_OWNER);
      for (let k = 0; k < n; k++) { idCalls.push([dex.nfpm, SEL.tokenOfOwnerByIndex + addrWord(o) + word(k)]); idOwner.push(o); }
    });
    const ids = (await calls(idCalls, rpcs)).map((r) => (r ? wordsOf(r)[0] : null));
    const posRaw = await calls(ids.map((id) => [dex.nfpm, SEL.positions + word(id || 0n)]), rpcs);

    const open = [];
    posRaw.forEach((r, i) => {
      if (!r || ids[i] == null) return;
      const w = wordsOf(r);
      if (w[7] === 0n) return; // closed
      open.push({ id: ids[i].toString(), owner: idOwner[i], token0: toAddr(w[2]), token1: toAddr(w[3]), fee: Number(w[4]),
        tickLower: Number(BigInt.asIntN(24, w[5])), tickUpper: Number(BigInt.asIntN(24, w[6])), liquidity: w[7] });
    });
    if (!open.length) return { positions: [], nativeUsd: 0 };

    const poolKeys = [...new Set(open.map((p) => `${p.token0}|${p.token1}|${p.fee}`))];
    const poolAddrs = (await calls(poolKeys.map((k) => {
      const [a, b, f] = k.split('|');
      return [dex.factory, SEL.getPool + addrWord(a) + addrWord(b) + word(f)];
    }), rpcs)).map((r) => (r ? toAddr(wordsOf(r)[0]) : null));
    const poolOf = Object.fromEntries(poolKeys.map((k, i) => [k, poolAddrs[i]]));
    const pools = poolAddrs.filter(Boolean);

    const tokens = [...new Set(open.flatMap((p) => [p.token0, p.token1]))];
    const [slot0s, liqs, fg0, fg1, syms, decs, blockHex] = await Promise.all([
      calls(pools.map((a) => [a, SEL.slot0]), rpcs),
      calls(pools.map((a) => [a, SEL.liquidity]), rpcs),
      calls(pools.map((a) => [a, SEL.feeGrowth0]), rpcs),
      calls(pools.map((a) => [a, SEL.feeGrowth1]), rpcs),
      calls(tokens.map((t) => [t, SEL.symbol]), rpcs),
      calls(tokens.map((t) => [t, SEL.decimals]), rpcs),
      rpcCall('eth_blockNumber', [], rpcs),
    ]);
    const past = '0x' + Math.max(0, parseInt(blockHex, 16) - chain.blocksPerDay).toString(16);
    // Yesterday's fee growth: every pool's two counters in one Multicall3 call
    // at the old block (archive nodes). If that fails the APR is just unknown.
    let fg0Old = [], fg1Old = [];
    try {
      const old = await multiRead(pools.flatMap((a) => [[a, SEL.feeGrowth0], [a, SEL.feeGrowth1]]), chain, past, chain.archiveRpcs);
      fg0Old = pools.map((_, i) => old[2 * i]);
      fg1Old = pools.map((_, i) => old[2 * i + 1]);
    } catch (_) { /* APR unknown */ }

    const prices = await dexScreenerPrices([...tokens, chain.wrapped], chain.dexscreenerSlug);
    const meta = Object.fromEntries(tokens.map((t, i) => [t, {
      id: t, symbol: decodeSymbol(syms[i]), decimals: decs[i] ? Number(wordsOf(decs[i])[0]) : 18,
      derivedUSD: String(prices[t] || 0),
    }]));
    const poolInfo = {};
    pools.forEach((a, i) => {
      const w = slot0s[i] ? wordsOf(slot0s[i]) : null;
      if (!w) return;
      const delta = (now, old) => (now && old ? BigInt.asUintN(256, wordsOf(now)[0] - wordsOf(old)[0]) : null);
      poolInfo[a] = { sqrtPrice: w[0].toString(), tick: Number(BigInt.asIntN(24, w[1])),
        liquidity: liqs[i] ? wordsOf(liqs[i])[0].toString() : '0',
        dFee0: delta(fg0[i], fg0Old[i]), dFee1: delta(fg1[i], fg1Old[i]) };
    });

    const Q128 = 1n << 128n;
    const positions = [];
    for (const p of open) {
      const poolAddr = poolOf[`${p.token0}|${p.token1}|${p.fee}`];
      const info = poolAddr && poolInfo[poolAddr];
      if (!info) continue;
      const t0 = meta[p.token0], t1 = meta[p.token1];
      let estDailyFeesUsd = null;
      if (info.dFee0 != null && info.dFee1 != null) {
        const f0 = toUnits((info.dFee0 * p.liquidity) / Q128, t0.decimals) * num(t0.derivedUSD);
        const f1 = toUnits((info.dFee1 * p.liquidity) / Q128, t1.decimals) * num(t1.derivedUSD);
        estDailyFeesUsd = f0 + f1;
      }
      positions.push({
        id: p.id, owner: p.owner, liquidity: p.liquidity.toString(), tickLower: p.tickLower, tickUpper: p.tickUpper,
        estDailyFeesUsd,
        pool: { id: poolAddr, feeTier: p.fee, tick: info.tick, sqrtPrice: info.sqrtPrice, liquidity: info.liquidity,
          token0: t0, token1: t1, poolDayData: [] },
      });
    }
    return { positions, nativeUsd: prices[chain.wrapped] || 0 };
  }

  const FETCHERS = {
    '9mm': fetch9mm, lbs: fetchLbs, switch: fetchSwitch,
    univ3: (owners, rpcs) => fetchUniswapV3(owners, rpcs, 'univ3'),
    '9mmeth': (owners, rpcs) => fetchUniswapV3(owners, rpcs, '9mmeth'),
  };

  /**
   * Open positions across every DEX, each row stamped with `dex`. One DEX
   * failing doesn't hide the others: its message lands in `errors[dex]`.
   */
  async function fetchPositions(owners, rpcs) {
    const list = [...new Set(owners.map((o) => o.toLowerCase()))].filter(isAddress);
    const out = { positions: [], plsUsd: 0, nativeUsd: {}, errors: {} };
    if (!list.length) return out;
    const keys = Object.keys(FETCHERS);
    const settled = await Promise.allSettled(keys.map((k) => FETCHERS[k](list, rpcs)));
    settled.forEach((r, i) => {
      const dex = keys[i];
      if (r.status === 'rejected') { out.errors[dex] = (r.reason && r.reason.message) || String(r.reason); return; }
      for (const p of r.value.positions) {
        if (p.tickLower == null || p.tickUpper == null) continue;
        out.positions.push({ ...p, dex, owner: p.owner.toLowerCase() });
      }
      if (!out.plsUsd && r.value.plsUsd) out.plsUsd = r.value.plsUsd;
      const ch = DEXES[dex].chain;
      const native = ch === 'pulsechain' ? r.value.plsUsd : r.value.nativeUsd;
      if (native && !out.nativeUsd[ch]) out.nativeUsd[ch] = native;
    });
    await fillBlankSymbols(out.positions);
    return out;
  }

  /**
   * Subgraphs can index a token with an empty symbol: the 9mm PulseChain one
   * has "" for bridged WETH (0x02dc...3c3c), so its pairs read "/ WPLS". Read
   * those symbols from the token contracts instead. A failed read leaves the
   * row as it was.
   */
  async function fillBlankSymbols(positions) {
    const blank = new Map(); // chain -> Set of token addresses
    for (const p of positions) {
      const ch = DEXES[p.dex].chain;
      for (const t of [p.pool.token0, p.pool.token1]) {
        if (String(t.symbol || '').trim()) continue;
        if (!blank.has(ch)) blank.set(ch, new Set());
        blank.get(ch).add(t.id.toLowerCase());
      }
    }
    const found = {};
    await Promise.all([...blank].map(async ([ch, set]) => {
      const tokens = [...set];
      try {
        const syms = await calls(tokens.map((t) => [t, SEL.symbol]), chainOf(ch).rpcs);
        tokens.forEach((t, i) => { const s = decodeSymbol(syms[i]); if (s !== '?') found[ch + '|' + t] = s; });
      } catch (_) { /* keep the blank */ }
    }));
    for (const p of positions) {
      const ch = DEXES[p.dex].chain;
      for (const t of [p.pool.token0, p.pool.token1]) {
        const s = !String(t.symbol || '').trim() && found[ch + '|' + t.id.toLowerCase()];
        if (s) t.symbol = s;
      }
    }
  }

  /**
   * Unclaimed fees via a collect() staticcall from the owner, the same trick the
   * app uses. Items are {id, owner, nfpm, chain}. Returns [{fee0, fee1}] as raw
   * BigInt, or {error} per position.
   */
  async function fetchFees(items, rpcs) {
    // Items are {id, owner, nfpm, chain}; each chain's calls go to its own RPCs.
    const out = new Array(items.length);
    const byChain = {};
    items.forEach((it, i) => { (byChain[it.chain || 'pulsechain'] = byChain[it.chain || 'pulsechain'] || []).push(i); });
    await Promise.all(Object.entries(byChain).map(async ([key, idx]) => {
      const reqs = idx.map((i) => ({
        method: 'eth_call',
        params: [{ from: items[i].owner, to: items[i].nfpm, data: encCollect(items[i].id, '0x0000000000000000000000000000000000000000') }, 'latest'],
      }));
      const res = await rpcBatchChunked(reqs, 25, 3, rpcs || chainOf(key).rpcs);
      res.forEach((r, k) => {
        out[idx[k]] = (r.error || !r.result || strip(r.result).length < 128)
          ? { error: revertReason(r.error) }
          : { fee0: wordsOf(r.result)[0], fee1: wordsOf(r.result)[1] };
      });
    }));
    return out;
  }

  async function readAllowance(token, owner, spender, rpcs) {
    const r = await ethCall(token, SEL.allowance + addrWord(owner) + addrWord(spender), null, rpcs);
    return wordsOf(r)[0] || 0n;
  }

  /**
   * positions(tokenId) on a DEX's manager. Word 4 is the fee tier on
   * Uniswap-style managers and the pool deployer on Switch (Algebra), so it is
   * not returned; the other offsets match on both.
   */
  async function readPosition(nfpm, tokenId, rpcs) {
    const w = wordsOf(await ethCall(nfpm, SEL.positions + word(tokenId), null, rpcs));
    const toAddr = (x) => '0x' + x.toString(16).padStart(40, '0');
    return {
      token0: toAddr(w[2]), token1: toAddr(w[3]),
      tickLower: Number(BigInt.asIntN(24, w[5])), tickUpper: Number(BigInt.asIntN(24, w[6])),
      liquidity: w[7],
    };
  }

  // ---------- maths ----------
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  const toUnits = (raw, dec) => Number(raw) / 10 ** dec;

  /** Tick maths for a concentrated position, as WalletCalcs.computeV3TokenAmounts. */
  function positionAmounts(liquidity, sqrtPriceX96, tick, tickLower, tickUpper) {
    const L = num(liquidity);
    const sp = num(sqrtPriceX96) / Q96;
    const sa = Math.pow(1.0001, tickLower / 2);
    const sb = Math.pow(1.0001, tickUpper / 2);
    if (tick < tickLower) return { a0: (L * (sb - sa)) / (sa * sb), a1: 0 };
    if (tick >= tickUpper) return { a0: 0, a1: L * (sb - sa) };
    return { a0: (L * (sb - sp)) / (sp * sb), a1: L * (sp - sa) };
  }

  /**
   * One day's fees and TVL for the pool, preferring the last COMPLETE day: the
   * newest poolDayData row is still accumulating and reads low. Same gates as
   * the app's computePoolFeeAPR (TVL at least $1, APR at most 1000%).
   */
  function poolDay(dayData) {
    if (!dayData || !dayData.length) return null;
    const m = (d) => {
      const fees = num(d.feesUSD), tvl = num(d.tvlUSD);
      return tvl >= 1 && fees >= 0 ? { fees, tvl } : null;
    };
    return (dayData.length > 1 ? m(dayData[1]) : null) || m(dayData[0]);
  }

  /**
   * Turn a subgraph row plus its fee read into everything the page shows.
   *
   * estApr is this position's own fee rate: the pool's daily fees times the
   * position's share of ACTIVE liquidity (pool.liquidity is the liquidity at
   * the current tick), annualised over the position's value. It is 0 out of
   * range, which is what makes it the right pick for "which of my HEX/WPLS
   * positions should the fees go into": a narrow in-range position earns more
   * per dollar than a wide one in the same pool, and the pool APR can't see that.
   */
  function buildPosition(p, fee) {
    const pool = p.pool, t0 = pool.token0, t1 = pool.token1;
    const d0 = num(t0.decimals), d1 = num(t1.decimals);
    const tick = num(pool.tick), tl = num(p.tickLower), tu = num(p.tickUpper);
    const { a0, a1 } = positionAmounts(p.liquidity, pool.sqrtPrice, tick, tl, tu);
    const amt0 = a0 / 10 ** d0, amt1 = a1 / 10 ** d1;
    const p0 = num(t0.derivedUSD), p1 = num(t1.derivedUSD);
    const value = amt0 * p0 + amt1 * p1;
    const inRange = tick >= tl && tick < tu;

    const day = poolDay(pool.poolDayData);
    let poolApr = day ? (day.fees / day.tvl) * 365 * 100 : null;
    if (poolApr != null && (!Number.isFinite(poolApr) || poolApr > 1000)) poolApr = null;

    const Lpool = num(pool.liquidity);
    let estApr = null;
    if (!inRange) estApr = 0;
    else if (p.estDailyFeesUsd != null && value >= 1) {
      // Chains without a subgraph: the position's own fees from the pool's
      // 24h fee growth (fetchUniswapV3). Same 1000% ceiling as below.
      estApr = (p.estDailyFeesUsd * 365 / value) * 100;
      if (!Number.isFinite(estApr) || estApr > 1000) estApr = null;
    } else if (day && Lpool > 0 && value >= 1) {
      estApr = ((day.fees * (num(p.liquidity) / Lpool) * 365) / value) * 100;
      // Same 1000% ceiling as the pool APR. The estimate assumes the day's
      // volume all traded at the current tick; in a pool whose liquidity sits
      // mostly out of range it does not. Measured: Switch WETH/WPLS #53 held
      // half the active liquidity of a $26k-TVL pool, so it read 61,222% on $79
      // while its real unclaimed fees were $0.13. Unknown beats that, and it
      // also keeps such a position from winning the compound target.
      if (!Number.isFinite(estApr) || estApr > 1000) estApr = null;
    }

    const ok = fee && !fee.error;
    const fee0Raw = ok ? fee.fee0 : null, fee1Raw = ok ? fee.fee1 : null;
    const fee0 = ok ? toUnits(fee0Raw, d0) : 0, fee1 = ok ? toUnits(fee1Raw, d1) : 0;
    const hist = positionHistory(p, { value, amt0, amt1, p0, p1, poolPrice: poolPriceOf(pool, d0, d1),
      unclaimed0: ok ? fee0 : null, unclaimed1: ok ? fee1 : null });

    return {
      id: String(p.id), dex: p.dex, dexLabel: DEXES[p.dex].label, nfpm: DEXES[p.dex].nfpm,
      chain: DEXES[p.dex].chain, chainName: chainOf(DEXES[p.dex].chain).name,
      uid: p.dex + ':' + p.id, owner: p.owner.toLowerCase(), poolId: pool.id,
      feeTier: num(pool.feeTier), tick, tickLower: tl, tickUpper: tu, liquidity: p.liquidity,
      token0: { address: t0.id.toLowerCase(), symbol: t0.symbol, decimals: d0, usd: p0 },
      token1: { address: t1.id.toLowerCase(), symbol: t1.symbol, decimals: d1, usd: p1 },
      amt0, amt1, value, inRange, poolApr, estApr,
      fee0Raw, fee1Raw, fee0, fee1, claimUsd: fee0 * p0 + fee1 * p1,
      feeError: ok ? null : (fee && fee.error) || 'fee read failed',
      hasHistory: p.snapshots != null,
      hist, // see positionHistory; null when unknown
      netUsd: hist ? hist.netUsd : null,
    };
  }

  /** Price of token0 in token1 from the pool's sqrtPriceX96. */
  const poolPriceOf = (pool, d0, d1) => Math.pow(num(pool.sqrtPrice) / Q96, 2) * Math.pow(10, d0 - d1);

  /**
   * Net against holding, over the tracked wallets' stretch of the position.
   *
   * "Held instead" starts as the tokens put in at mint, or what the position
   * held when it was received. Every later add joins it, compounded fees
   * included (they were yours before they went back in). Each withdrawal takes
   * the same share of it as the share of liquidity removed, the way a cost
   * basis is averaged, so a big partial withdrawal can't leave the rest measured
   * against the whole history. All valued at today's prices.
   *
   * - Unrealised IL: value now minus "held instead" still in the position.
   * - Realised IL: on each withdrawal, what came out minus its share of "held
   *   instead" (tokens kept, valued today).
   * - Fees earned: collected + unclaimed - withdrawn over the stretch, per token.
   *   The subgraph's collectedFeesToken* counts withdrawn principal (#9802:
   *   collected equals withdrawn, no fees), so principal must come off.
   * Per position these add up: compounding counts fees as earned where they
   * came from and as put in where they went.
   */
  function positionHistory(p, { value, amt0, amt1, p0, p1, poolPrice, unclaimed0, unclaimed1 }) {
    const snaps = p.snapshots, t = p.tenure;
    if (!snaps || !t || !(p0 > 0) || !(p1 > 0)) return null;
    // Tokens are compared at the pool's own price, scaled so the position is
    // worth what the Value column says. Market prices can sit well off a thin
    // pool's (INC/PLSX #165843: 16%), and valuing both sides at those makes IL
    // read as a gain, which a V3 position can't have. Fees use market prices.
    const v1 = amt0 * poolPrice + amt1;
    const k = poolPrice > 0 && v1 > 0 ? value / v1 : 0;
    const q0 = k > 0 ? k * poolPrice : p0, q1 = k > 0 ? k : p1;
    if (t.received && !t.startAmounts) return null; // no price at receipt
    const n = (row, k) => num(row[k]);
    const ZERO = { liquidity: '0', depositedToken0: 0, depositedToken1: 0, withdrawnToken0: 0, withdrawnToken1: 0,
      collectedFeesToken0: 0, collectedFeesToken1: 0 };
    const base = t.received ? snaps[t.start] : ZERO;
    let b0 = t.received ? t.startAmounts.a0 : 0, b1 = t.received ? t.startAmounts.a1 : 0;
    let in0 = b0, in1 = b1, r0 = 0, r1 = 0, out0 = 0, out1 = 0, withdrawals = 0;
    let prev = base;
    for (let k = t.received ? t.start + 1 : 0; k < snaps.length; k++) {
      const s = snaps[k];
      const dDep0 = n(s, 'depositedToken0') - n(prev, 'depositedToken0'), dDep1 = n(s, 'depositedToken1') - n(prev, 'depositedToken1');
      const dWd0 = n(s, 'withdrawnToken0') - n(prev, 'withdrawnToken0'), dWd1 = n(s, 'withdrawnToken1') - n(prev, 'withdrawnToken1');
      const Lp = num(prev.liquidity), Ln = num(s.liquidity);
      if ((dWd0 > 0 || dWd1 > 0) && Lp > 0) {
        // Share of liquidity removed. An add in the same block hides part of the
        // drop, so there it reads low; a remove and an add in one block is rare.
        const f = Math.min(1, Math.max(0, (Lp - Ln) / Lp));
        r0 += dWd0 - f * b0; r1 += dWd1 - f * b1;
        b0 *= 1 - f; b1 *= 1 - f;
        out0 += dWd0; out1 += dWd1; withdrawals++;
      }
      if (dDep0 > 0 || dDep1 > 0) { b0 += Math.max(0, dDep0); b1 += Math.max(0, dDep1); in0 += Math.max(0, dDep0); in1 += Math.max(0, dDep1); }
      prev = s;
    }
    const last = prev;
    const heldUsd = b0 * q0 + b1 * q1;
    const ilUsd = value - heldUsd;
    const realisedUsd = r0 * q0 + r1 * q1;
    let earnedUsd = null, earned0 = null, earned1 = null;
    if (unclaimed0 != null) {
      earned0 = Math.max(0, n(last, 'collectedFeesToken0') - n(base, 'collectedFeesToken0') + unclaimed0 - (n(last, 'withdrawnToken0') - n(base, 'withdrawnToken0')));
      earned1 = Math.max(0, n(last, 'collectedFeesToken1') - n(base, 'collectedFeesToken1') + unclaimed1 - (n(last, 'withdrawnToken1') - n(base, 'withdrawnToken1')));
      earnedUsd = earned0 * p0 + earned1 * p1;
    }
    const ilTotalUsd = ilUsd + realisedUsd;
    const inUsd = in0 * q0 + in1 * q1;
    return {
      received: t.received, since: t.since,
      held0: b0, held1: b1, heldUsd, in0, in1, inUsd, out0, out1, withdrawals,
      ilUsd, realisedUsd, ilTotalUsd, ilPct: inUsd > 0 ? (ilTotalUsd / inUsd) * 100 : null,
      earned0, earned1, earnedUsd, netUsd: earnedUsd == null ? null : ilTotalUsd + earnedUsd,
    };
  }

  /**
   * Group a wallet's positions by DEX and token pair (any fee tier) and pick where the
   * fees go: the in-range position with the highest estimated APR. No in-range
   * position means no target; the group can still be collected.
   */
  function buildGroups(positions) {
    const map = new Map();
    for (const p of positions) {
      // Per DEX: one multicall can only touch one position manager, so pooling
      // a pair across DEXes would need a second transaction.
      const key = `${p.dex}|${p.owner}|${p.token0.address}|${p.token1.address}`;
      if (!map.has(key)) map.set(key, { key, dex: p.dex, dexLabel: p.dexLabel, nfpm: p.nfpm, chain: p.chain, chainName: p.chainName,
        owner: p.owner, token0: p.token0, token1: p.token1, positions: [] });
      map.get(key).positions.push(p);
    }
    const groups = [];
    for (const g of map.values()) {
      // An in-range position with no recent pool fees has an unknown APR, not a
      // zero one; it still qualifies, ranked below any known APR, then by value.
      const rank = (p) => (p.estApr == null ? -1 : p.estApr);
      let target = null;
      for (const p of g.positions) {
        if (!p.inRange) continue;
        if (!target || rank(p) > rank(target) || (rank(p) === rank(target) && p.value > target.value)) target = p;
      }
      g.target = target;
      g.claimUsd = g.positions.reduce((s, p) => s + p.claimUsd, 0);
      g.value = g.positions.reduce((s, p) => s + p.value, 0);
      g.fee0 = g.positions.reduce((s, p) => s + p.fee0, 0);
      g.fee1 = g.positions.reduce((s, p) => s + p.fee1, 0);
      g.hasFeeError = g.positions.some((p) => p.feeError);
      // Pair total for the Net popover; unknown if any position is.
      g.netUsd = g.positions.every((p) => p.netUsd != null) ? g.positions.reduce((s, p) => s + p.netUsd, 0) : null;
      groups.push(g);
    }
    return groups;
  }

  /** Apply a slippage tolerance in basis points to a raw amount. */
  const withSlippage = (raw, bps) => (raw * BigInt(10000 - bps)) / 10000n;

  /**
   * Build the compound transaction for a group: collect every position's fees
   * to the owner, then add them to the target in the same transaction.
   * minUsed is null for the first (simulation) pass.
   */
  function buildCompoundData({ ids, owner, targetId, amount0, amount1, min0 = 0n, min1 = 0n, deadline }) {
    const calls = ids.map((id) => encCollect(id, owner));
    calls.push(encIncrease(targetId, amount0, amount1, min0, min1, deadline));
    return encMulticall(calls);
  }

  /**
   * Collect every position's fees to the owner. With `unwrap` ({ dex, other,
   * minWrapped, minOther }) the fees are collected into the position manager
   * instead, its wrapped-native balance is unwrapped to the owner as native
   * PLS/ETH, and the other token is swept to the owner: 9mm's "collect as
   * PLS", one transaction. Simulated on all five managers 2026-09-25. The
   * minimums are the fees just read, so if they were collected elsewhere in
   * the meantime the transaction reverts instead of sending less.
   */
  function buildCollectData({ ids, owner, nfpm, unwrap }) {
    if (!unwrap) return encMulticall(ids.map((id) => encCollect(id, owner)));
    const sel = SEL[DEXES[unwrap.dex].unwrap || 'unwrapWETH9'];
    const calls = ids.map((id) => encCollect(id, nfpm));
    calls.push(sel + word(unwrap.minWrapped) + addrWord(owner));
    calls.push(SEL.sweepToken + addrWord(unwrap.other) + word(unwrap.minOther) + addrWord(owner));
    return encMulticall(calls);
  }

  /** increaseLiquidity's return, the last item of the multicall result. */
  function decodeIncreaseResult(multicallResult) {
    const items = decBytesArray(multicallResult);
    const [liquidity, used0, used1] = wordsOf(items[items.length - 1]);
    return { liquidity, used0, used1 };
  }

  const api = {
    CFG, CHAINS, chainOf, DEXES, SEL, MAX128, MAX256, isAddress,
    encCollect, encIncrease, encMulticall, decBytesArray, wordsOf, word, addrWord, revertReason,
    rpcBatch, rpcBatchChunked, rpcCall, ethCall, gql,
    fetchPositions, fetch9mm, fetchLbs, fetchSwitch, fetchUniswapV3, dexScreenerPrices, decodeSymbol, fetchFees, readAllowance, readPosition,
    encAggregate3, decAggregate3, multiRead,
    positionAmounts, poolDay, buildPosition, buildGroups, withSlippage, toUnits, tenureOf, positionHistory,
    buildCompoundData, buildCollectData, decodeIncreaseResult,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YieldCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

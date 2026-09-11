/* NADIR terminal dashboard: reads via RPC, transacts via injected wallet (or a dev key on localhost). */
(() => {
  const C = window.BOND_CONFIG;
  const { ethers } = window;
  const A = window.ASCII;
  const Q96 = 1n << 96n;

  const ENGINE_ABI = [
    "function token() view returns (address)",
    "function started() view returns (bool)",
    "function epoch() view returns (uint32)",
    "function epochLength() view returns (uint64)",
    "function lastSampleAt() view returns (uint64)",
    "function sampleCount() view returns (uint32)",
    "function sampleCursor() view returns (uint32)",
    "function sampleAt(uint32) view returns (uint256)",
    "function spot() view returns (uint256)",
    "function target() view returns (uint256)",
    "function discountBps() view returns (uint16)",
    "function bonusBps() view returns (uint16)",
    "function isPaused() view returns (bool)",
    "function ethReserve() view returns (uint256)",
    "function crypt() view returns (uint256)",
    "function totalStaked() view returns (uint256)",
    "function totalBurned() view returns (uint256)",
    "function totalBoughtBack() view returns (uint256)",
    "function bondedOutstanding() view returns (uint256)",
    "function params() view returns (uint16 maxBonusBps,uint16 bandBps,uint16 entryBurnBps,uint16 penaltyBps,uint16 releaseBps,uint16 stakingShareBps,uint16 window,uint16 vestEpochs,uint16 minSamples)",
    "function TIP_BPS() view returns (uint16)",
    "function TIP_CAP() view returns (uint256)",
    "function staked(address) view returns (uint256)",
    "function earned(address) view returns (uint256)",
    "function bondIdsOf(address) view returns (uint256[])",
    "function bonds(uint256) view returns (address owner,uint128 principal,uint128 payout,uint32 createdEpoch,uint32 maturityEpoch,bool closed)",
    "function queueHead() view returns (uint256)",
    "function start()",
    "function poke()",
    "function settle(uint256) returns (uint256)",
    "function bond(uint256 amount,uint16 minBonusBps) returns (uint256)",
    "function exit(uint256 id)",
    "function stake(uint256)",
    "function unstake(uint256)",
    "function claimRewards() returns (uint256)",
  ];
  const SPLITTER_ABI = [
    "function pending() view returns (uint256)",
    "function treasuryBps() view returns (uint16)",
    "function totalHarvested() view returns (uint256)",
    "function totalToTreasury() view returns (uint256)",
    "function totalToProtocol() view returns (uint256)",
    "function treasury() view returns (address)",
    "function harvest() returns (uint256)",
  ];
  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ];

  const $ = (id) => document.getElementById(id);
  const provider = window.RPC.makeProvider(ethers, C);
  const mcall = (calls) => window.RPC.multicall(ethers, provider, C.multicall, calls);
  const engineR = new ethers.Contract(C.engine, ENGINE_ABI, provider);
  const splitterR = new ethers.Contract(C.splitter, SPLITTER_ABI, provider);
  let tokenR = new ethers.Contract(C.token, ERC20_ABI, provider);
  let signer = null, account = null, decimals = 18, symbol = C.tokenSymbol || "TOKEN", params = null, currentBonusBps = 0;

  const loc = "en-US";
  const fmtTok = (v, d = 0) => Number(ethers.formatUnits(v, decimals)).toLocaleString(loc, { maximumFractionDigits: d });
  const fmtEth = (v, d = 4) => Number(ethers.formatEther(v)).toLocaleString(loc, { maximumFractionDigits: d }) + " ETH";
  const fromQ96 = (q) => Number((q * 1000000n) / Q96) / 1e6;
  const fmtNum = (n, d = 2) => n.toLocaleString(loc, { maximumFractionDigits: d });
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const explorer = (path) => `${C.explorer}/${path}`;
  const clock = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0"); };
  const prompt = (text, err) => { const p = $("prompt"); p.className = "prompt" + (err ? " err" : ""); p.innerHTML = "&gt; " + text.replace(/</g, "&lt;") + '<span class="cur">█</span>'; };

  // ---------------------------------------------------------------- static art
  function paintHeader() {
    $("logo").textContent = A.logo(C.name || "NADIR");
    $("moon").innerHTML = A.moonHTML;
    A.favicon();
    $("rain").textContent = A.rain(88, 14);
    $("ground").textContent = A.ground(120);
    const bar = $("abar");
    [["CONNECT", "#connect", "connectBtn"], ["STAKE", "#stake"], ["BOND", "#bond"], ["DASHBOARD", "#dashboard"], ["NFO", "docs.html"]].forEach(([label, href, id]) => {
      const a = document.createElement("a");
      a.className = "abtn"; a.href = href; a.innerHTML = `<pre>${A.button(label)}</pre>`;
      if (id) { a.id = id; a.onclick = (e) => { e.preventDefault(); connect(); }; }
      bar.appendChild(a);
    });
  }

  // ---------------------------------------------------------------- chart (ascii sparkline)
  async function refreshChart() {
    try {
      const [cursor, count, target, spot] = await mcall([{ c: engineR, f: "sampleCursor" }, { c: engineR, f: "sampleCount" }, { c: engineR, f: "target" }, { c: engineR, f: "spot" }]);
      const n = Math.min(Number(count), 60);
      if (n === 0) return;
      const idx = []; for (let i = n; i >= 1; i--) idx.push(Number(cursor) - i);
      const samples = await mcall(idx.map((i) => ({ c: engineR, f: "sampleAt", a: [i] })));
      const toPrice = (q) => (q > 0n ? 1e6 / fromQ96(q) : 0);
      const vals = samples.map(toPrice); if (spot > 0n) vals.push(toPrice(spot));
      $("spark").innerHTML = A.spark(vals, target > 0n ? toPrice(target) : null);
      $("sparkNote").textContent = `price history · last ${n} epochs · ETH per 1M tokens`;
    } catch (e) { console.warn("chart", e); }
  }

  // ---------------------------------------------------------------- stats
  async function refresh() {
    try {
      const E = (f) => ({ c: engineR, f }), S = (f) => ({ c: splitterR, f });
      const [started, epoch, epochLength, lastSampleAt, sampleCount, spot, target, discount, bonus, paused, ethReserve, crypt, totalStaked, burned, boughtBack, outstanding, p, tipBps, tipCap,
        pending, tBps, harvested, toT, toP] = await mcall([
        E("started"), E("epoch"), E("epochLength"), E("lastSampleAt"), E("sampleCount"), E("spot"), E("target"), E("discountBps"), E("bonusBps"), E("isPaused"),
        E("ethReserve"), E("crypt"), E("totalStaked"), E("totalBurned"), E("totalBoughtBack"), E("bondedOutstanding"), E("params"), E("TIP_BPS"), E("TIP_CAP"),
        S("pending"), S("treasuryBps"), S("totalHarvested"), S("totalToTreasury"), S("totalToProtocol"),
      ]);
      params = p; currentBonusBps = Number(bonus);
      const next = Number(lastSampleAt + epochLength) - Math.floor(Date.now() / 1000);
      const state = !started ? "WAITING FOR POOL" : paused ? "ENTRIES PAUSED" : Number(discount) > 0 ? "BONDS OPEN" : "ABOVE TARGET";
      const stateTag = state === "BONDS OPEN" ? `<b>${state}</b>` : state === "ENTRIES PAUSED" ? `<i>${state}</i>` : state;
      $("statusbar").innerHTML = ` EPOCH ${epoch}  ${stateTag}  next poke ${!started ? "—" : next <= 0 ? "now" : "in " + clock(next)}  spot ${spot > 0n ? fmtNum(fromQ96(spot), 0) : "—"}  target ${target > 0n ? fmtNum(fromQ96(target), 0) : "—"}  ${(Number(discount) / 100).toFixed(2)}% below`;
      $("discount").textContent = (Number(discount) / 100).toFixed(2);
      $("bonus").textContent = (Number(bonus) / 100).toFixed(2);
      $("spot").textContent = spot > 0n ? fmtNum(fromQ96(spot), 0) + " / ETH" : "—";
      $("target").textContent = target > 0n ? fmtNum(fromQ96(target), 0) + " / ETH" : "—";
      $("window").textContent = p.window.toString();
      $("epoch").textContent = epoch.toString();
      $("nextPoke").textContent = !started ? "after start" : next <= 0 ? "now" : clock(next);
      $("samples").textContent = `${sampleCount} (min ${p.minSamples})`;
      $("ethReserve").textContent = fmtEth(ethReserve);
      $("crypt").textContent = fmtTok(crypt) + " " + symbol;
      $("outstanding").textContent = fmtTok(outstanding) + " " + symbol;
      $("totalStaked").textContent = fmtTok(totalStaked) + " " + symbol;
      $("burned").textContent = fmtTok(burned) + " " + symbol;
      $("boughtBack").textContent = fmtTok(boughtBack) + " " + symbol;
      $("lastSample").textContent = lastSampleAt > 0n ? new Date(Number(lastSampleAt) * 1000).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" }) : "—";
      const tip = (ethReserve * BigInt(tipBps)) / 10000n;
      $("tip").textContent = fmtEth(tip < tipCap ? tip : tipCap, 5);
      $("vest").textContent = p.vestEpochs.toString();
      $("penalty").textContent = (Number(p.penaltyBps) / 100).toString();
      $("entryBurn").textContent = (Number(p.entryBurnBps) / 100).toString();
      $("stakingShare").textContent = (Number(p.stakingShareBps) / 100).toString();
      $("pokeBtn").textContent = started ? "POKE" : "START";
      $("pokeBtn").disabled = started ? next > 0 : spot === 0n;
      $("bondBtn").disabled = !started || Number(bonus) === 0 || Number(sampleCount) < Number(p.minSamples) || paused;
      $("bondHelp").textContent = !started ? "bonds open once the pool is live." : Number(sampleCount) < Number(p.minSamples) ? `bonds open after ${p.minSamples} samples.` : Number(bonus) === 0 ? "price is at or above target. bonds open when it drops below." : paused ? "new entries are paused." : "";
      $("pending").textContent = fmtEth(pending);
      $("treasuryBps").textContent = (Number(tBps) / 100).toString();
      $("harvested").textContent = fmtEth(harvested);
      $("toTreasury").textContent = fmtEth(toT);
      $("toProtocol").textContent = fmtEth(toP);
      $("harvestBtn").disabled = pending === 0n;
      quoteBond();
      if (account) await refreshUser();
      if (!$("prompt").dataset.busy) prompt(account ? `connected ${short(account)} · rpc ok` : "rpc ok · not connected");
    } catch (e) {
      console.error(e);
      if (e && (e.code === "BAD_DATA" || e.code === "CALL_EXCEPTION")) {
        $("statusbar").textContent = " CONTRACTS NOT DEPLOYED · launch pending";
        prompt("rpc ok · contracts not deployed on this chain yet", true);
      } else {
        $("statusbar").textContent = " RPC UNREACHABLE";
        prompt("rpc unreachable · " + (e.shortMessage || e.message), true);
      }
    }
  }

  async function refreshUser() {
    const [bal, st, earned, ids, epoch] = await mcall([{ c: tokenR, f: "balanceOf", a: [account] }, { c: engineR, f: "staked", a: [account] }, { c: engineR, f: "earned", a: [account] }, { c: engineR, f: "bondIdsOf", a: [account] }, { c: engineR, f: "epoch" }]);
    $("myStake").textContent = fmtTok(st) + " " + symbol;
    $("myEarned").textContent = fmtEth(earned, 6);
    $("bondMax").dataset.max = ethers.formatUnits(bal, decimals);
    $("stakeMax").dataset.max = ethers.formatUnits(bal, decimals);
    const tbody = $("myBonds");
    tbody.innerHTML = "";
    $("myBondsTable").hidden = ids.length === 0;
    if (ids.length === 0) return;
    const idList = [...ids].reverse();
    const [head, ...bondRows] = await mcall([{ c: engineR, f: "queueHead" }, ...idList.map((id) => ({ c: engineR, f: "bonds", a: [id] }))]);
    for (let k = 0; k < idList.length; k++) {
      const id = idList[k], b = bondRows[k];
      const matured = epoch >= b.maturityEpoch;
      const status = b.closed ? (id < head ? "paid" : "closed") : matured ? "matured · waiting for crypt" : `matures at epoch ${b.maturityEpoch}`;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${id}</td><td>${fmtTok(b.principal)}</td><td>${fmtTok(b.payout)}</td><td>${status}</td><td></td>`;
      if (!b.closed) {
        const btn = document.createElement("button");
        btn.className = "tbtn"; btn.textContent = "EXIT";
        btn.onclick = () => send(() => engineW().exit(id), `bond ${id} exited`);
        tr.lastElementChild.appendChild(btn);
      }
      tbody.appendChild(tr);
    }
  }

  function quoteBond() {
    const amt = parseFloat(($("bondAmt").value || "0").replace(",", "."));
    if (!params || !amt) return ($("bondQuote").textContent = "—");
    const principal = amt * (1 - Number(params.entryBurnBps) / 10000);
    const out = principal * (1 + currentBonusBps / 10000);
    $("bondQuote").textContent = `${fmtNum(out)} ${symbol} (+${(currentBonusBps / 100).toFixed(2)}%)`;
  }

  // ---------------------------------------------------------------- wallet
  async function connect() {
    try {
      if (C.devPrivateKey) {
        signer = new ethers.Wallet(C.devPrivateKey, provider);
      } else {
        if (!window.ethereum) return prompt("no wallet found", true);
        const bp = new ethers.BrowserProvider(window.ethereum);
        await bp.send("eth_requestAccounts", []);
        const net = await bp.getNetwork();
        if (Number(net.chainId) !== C.chainId) {
          try {
            await bp.send("wallet_switchEthereumChain", [{ chainId: "0x" + C.chainId.toString(16) }]);
          } catch {
            await bp.send("wallet_addEthereumChain", [{ chainId: "0x" + C.chainId.toString(16), chainName: C.chainName, rpcUrls: [C.rpc], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: [C.explorer] }]);
          }
        }
        signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
      }
      account = await signer.getAddress();
      $("connectBtn").innerHTML = `<pre>${A.button(short(account).toUpperCase())}</pre>`;
      $("connectBtn").classList.add("on");
      prompt(`connected ${short(account)}`);
      await refreshUser();
    } catch (e) { prompt(e.shortMessage || e.message, true); }
  }
  const engineW = () => new ethers.Contract(C.engine, ENGINE_ABI, signer);
  const splitterW = () => new ethers.Contract(C.splitter, SPLITTER_ABI, signer);
  const tokenW = () => new ethers.Contract(C.token, ERC20_ABI, signer);

  async function send(fn, okText) {
    if (!signer) { await connect(); if (!signer) return; }
    const p = $("prompt"); p.dataset.busy = "1";
    try {
      prompt("confirm in your wallet…");
      const tx = await fn();
      prompt(`pending ${tx.hash.slice(0, 12)}…`);
      await tx.wait();
      prompt(okText + " · " + tx.hash.slice(0, 12));
      await refresh();
      refreshChart();
      setTimeout(() => delete p.dataset.busy, 15000);
    } catch (e) {
      console.error(e);
      prompt(e.shortMessage || e.reason || e.message, true);
      setTimeout(() => delete p.dataset.busy, 15000);
    }
  }
  async function ensureAllowance(amount) {
    const cur = await tokenR.allowance(account, C.engine);
    if (cur >= amount) return;
    prompt("approving token…");
    const tx = await tokenW().approve(C.engine, ethers.MaxUint256);
    await tx.wait();
  }
  const parseAmt = (id) => ethers.parseUnits(($(id).value || "0").replace(",", "."), decimals);

  paintHeader();
  $("bondForm").onsubmit = (e) => { e.preventDefault(); send(async () => { const a = parseAmt("bondAmt"); await ensureAllowance(a); return engineW().bond(a, Math.max(0, currentBonusBps - 50)); }, "bond created"); };
  $("stakeForm").onsubmit = (e) => { e.preventDefault(); send(async () => { const a = parseAmt("stakeAmt"); await ensureAllowance(a); return engineW().stake(a); }, "staked"); };
  $("unstakeBtn").onclick = () => send(() => engineW().unstake(parseAmt("stakeAmt")), "unstaked");
  $("claimBtn").onclick = () => send(() => engineW().claimRewards(), "eth claimed");
  $("harvestBtn").onclick = () => send(() => splitterW().harvest(), "fees distributed");
  $("pokeBtn").onclick = () => send(async () => ((await engineR.started()) ? engineW().poke() : engineW().start()), "epoch advanced");
  $("settleBtn").onclick = () => send(() => engineW().settle(20), "queue settled");
  $("bondMax").onclick = () => { $("bondAmt").value = $("bondMax").dataset.max || ""; quoteBond(); };
  $("stakeMax").onclick = () => { $("stakeAmt").value = $("stakeMax").dataset.max || ""; };
  $("bondAmt").oninput = quoteBond;

  const ZERO = "0x0000000000000000000000000000000000000000";
  const disableActions = (on) => ["bondBtn", "stakeBtn", "unstakeBtn", "claimBtn", "harvestBtn", "pokeBtn", "settleBtn"].forEach((id) => { $(id).disabled = on; });
  async function preflight() {
    // 1. is the rpc alive?  2. is there code at the engine address?
    let block;
    try { block = await provider.getBlockNumber(); }
    catch (e) { $("statusbar").textContent = " RPC UNREACHABLE"; prompt("rpc unreachable · " + (e.shortMessage || e.message), true); return false; }
    if (!C.engine || C.engine === ZERO || (await provider.getCode(C.engine)) === "0x") {
      $("statusbar").textContent = ` ${C.chainName.toUpperCase()} · block ${block.toLocaleString(loc)} · CONTRACTS NOT DEPLOYED · launch pending`;
      prompt(`rpc ok · block ${block.toLocaleString(loc)} · contracts not deployed yet`);
      disableActions(true);
      return false;
    }
    return true;
  }

  (async () => {
    $("chainLabel").textContent = `· ${C.chainName.toLowerCase()} · chain ${C.chainId}`;
    if (!(await preflight())) { setInterval(async () => { if (await preflight()) location.reload(); }, 60000); return; }
    try {
      const tokenAddr = await engineR.token();
      tokenR = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
      C.token = tokenAddr;
      const [s, d] = await Promise.all([tokenR.symbol(), tokenR.decimals()]);
      symbol = s; decimals = Number(d);
      $("bondUnit").textContent = symbol; $("stakeUnit").textContent = symbol;
    } catch (e) { console.warn("token meta", e); }
    const treasury = await splitterR.treasury().catch(() => null);
    $("addrs").innerHTML = [["engine", C.engine], ["splitter", C.splitter], ["token", C.token], ["treasury", treasury]].filter(([, a]) => a)
      .map(([k, a]) => `${k} <a href="${explorer("address/" + a)}" target="_blank" rel="noopener">${a}</a>`).join("<br>");
    await refresh();
    refreshChart();
    setInterval(refresh, 20000);
    setInterval(refreshChart, 60000);
  })();
})();

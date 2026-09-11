/* RPC helpers: failover provider over a list of URLs + Multicall3 batching (falls back to direct calls). */
(function (root) {
  const MULTICALL3_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"];

  // One provider, many URLs: each JSON-RPC request is sent to the first URL that answers; the next URL is
  // tried on network error, HTTP error or a JSON-RPC "limit" error. No quorum logic, no startup cost.
  function makeProvider(ethers, cfg) {
    const urls = (cfg.rpcs && cfg.rpcs.length ? cfg.rpcs : [cfg.rpc]).filter(Boolean);
    const net = ethers.Network.from(cfg.chainId);
    class FailoverProvider extends ethers.JsonRpcProvider {
      constructor() { super(urls[0], net, { staticNetwork: net, batchMaxCount: 1 }); this.urls = urls; this.current = 0; }
      async _send(payload) {
        let lastErr = null;
        for (let k = 0; k < this.urls.length; k++) {
          const i = (this.current + k) % this.urls.length;
          try {
            const req = new ethers.FetchRequest(this.urls[i]);
            req.body = JSON.stringify(payload);
            req.setHeader("content-type", "application/json");
            req.timeout = 8000;
            const resp = await req.send();
            resp.assertOk();
            let result = resp.bodyJson;
            if (!Array.isArray(result)) result = [result];
            const limited = result.some((r) => r && r.error && /limit|rate|busy|capacity/i.test(r.error.message || ""));
            if (limited) throw new Error("rpc limited: " + this.urls[i]);
            this.current = i;
            return result;
          } catch (e) { lastErr = e; }
        }
        throw lastErr;
      }
    }
    return new FailoverProvider();
  }

  // calls: [{ c: ethers.Contract, f: "fnName", a: [args] }, ...] -> array of decoded single results (or full result for tuples)
  async function multicall(ethers, provider, mcAddress, calls) {
    if (!mcAddress) return Promise.all(calls.map(({ c, f, a = [] }) => c.getFunction(f)(...a)));
    const mc = new ethers.Contract(mcAddress, MULTICALL3_ABI, provider);
    const payload = calls.map(({ c, f, a = [] }) => ({ target: c.target, allowFailure: true, callData: c.interface.encodeFunctionData(f, a) }));
    const res = await mc.aggregate3.staticCall(payload);
    return calls.map(({ c, f }, i) => {
      if (!res[i].success) throw new Error(`multicall: ${f} failed`);
      const out = c.interface.decodeFunctionResult(f, res[i].returnData);
      return out.length === 1 ? out[0] : out;
    });
  }

  root.RPC = { makeProvider, multicall, MULTICALL3_ABI };
})(typeof window !== "undefined" ? window : globalThis);

// Verify a deployed contract on Sourcify (works for Robinhood Chain; Blockscout's own API sits behind Cloudflare).
//   node scripts/verify-sourcify.js <address> contracts/StakedNadir.sol:StakedNadir [chainId=4663]
// Builds a minimal standard-json input (only the sources the contract needs) from the latest Hardhat build-info.
const fs = require("fs");
const path = require("path");

const [address, identifier, chainArg] = process.argv.slice(2);
if (!address || !identifier) { console.error("usage: node scripts/verify-sourcify.js <address> <path/File.sol:Name> [chainId]"); process.exit(1); }
const chainId = chainArg || "4663";
const [rootFile] = identifier.split(":");

const dir = path.join(__dirname, "..", "artifacts", "build-info");
let input = null, solc = null;
for (const f of fs.readdirSync(dir)) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  if (j.input.sources[rootFile]) { input = j.input; solc = j.solcLongVersion; }
}
if (!input) throw new Error("no build-info contains " + rootFile + " (run npx hardhat compile)");

const resolve = (from, imp) => (imp.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(from), imp)) : imp);
const need = new Set(); const q = [rootFile];
while (q.length) {
  const f = q.pop(); if (need.has(f)) continue; need.add(f);
  for (const m of input.sources[f].content.matchAll(/import\s+(?:[^"']*?from\s+)?["']([^"']+)["']/g)) q.push(resolve(f, m[1]));
}
const sources = {}; for (const k of need) sources[k] = input.sources[k];
const stdJsonInput = { language: input.language, sources, settings: input.settings };

(async () => {
  const r = await fetch(`https://sourcify.dev/server/v2/verify/${chainId}/${address}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stdJsonInput, compilerVersion: solc, contractIdentifier: identifier }),
  });
  const t = await r.text();
  console.log("submit:", r.status, t.slice(0, 200));
  let id; try { id = JSON.parse(t).verificationId; } catch {}
  if (!id) return;
  for (let i = 0; i < 30; i++) {
    await new Promise((s) => setTimeout(s, 3000));
    const j = await fetch("https://sourcify.dev/server/v2/verify/" + id).then((x) => x.json());
    if (j.isJobCompleted) { console.log("job:", j.error ? JSON.stringify(j.error).slice(0, 300) : "done"); break; }
  }
  const c = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`).then((x) => x.json()).catch(() => null);
  console.log("sourcify:", c ? `${c.match} (runtime ${c.runtimeMatch}, creation ${c.creationMatch})` : "not found");
  console.log(`repo: https://repo.sourcify.dev/${chainId}/${address}`);
})().catch((e) => { console.error(e); process.exit(1); });

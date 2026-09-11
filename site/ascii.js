/* ASCII helpers: block-letter logo (ANSI Shadow style), shaded crescent moon, ascii buttons, sparkline. */
window.ASCII = (() => {
  const NL = String.fromCharCode(10);
  const F = {
    N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
    A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
    D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
    I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
    R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
    E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
    O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
    S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
    " ": ["  ", "  ", "  ", "  ", "  ", "  "],
  };
  const logo = (word) => {
    const rows = [];
    for (let r = 0; r < 6; r++) rows.push([...word.toUpperCase()].map((ch) => (F[ch] || F[" "])[r]).join(" "));
    return rows.join(NL);
  };

  // Crescent like a waxing moon photo: a disc minus a slightly smaller disc offset up-right.
  // Pixel values: 0 = dark sky, 2 = lit limb (bright), 1 = terminator / craters (dim).
  const moonGrid = (D = 28, r = 13.5, r2 = 13.2, d = 8, thetaDeg = 30, band = 2.0) => {
    const cx = D / 2, cy = D / 2, th = (thetaDeg * Math.PI) / 180;
    const ox = cx + d * Math.cos(th), oy = cy - d * Math.sin(th);
    let s = 11; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const g = [];
    for (let y = 0; y < D; y++) {
      const row = [];
      for (let x = 0; x < D; x++) {
        const px = x + 0.5, py = y + 0.5;
        const dBig = Math.hypot(px - cx, py - cy), dCut = Math.hypot(px - ox, py - oy);
        const lit = dBig <= r && dCut > r2;
        let v = 0;
        if (lit) {
          v = dCut - r2 < band || r - dBig < 0.35 ? 1 : 2;
          if (v === 2 && rnd() > 0.88) v = 1; // craters
        }
        row.push(v);
      }
      g.push(row);
    }
    return g;
  };
  // half-block rendering (2 px per character row); lines keep a constant width so centering does not warp the shape
  const renderMoon = (g, html) => {
    const lines = [];
    for (let y = 0; y < g.length; y += 2) {
      let line = "";
      for (let x = 0; x < g[0].length; x++) {
        const t = g[y][x], b = g[y + 1] ? g[y + 1][x] : 0;
        const ch = t && b ? "█" : t ? "▀" : b ? "▄" : " ";
        if (!html || ch === " ") { line += ch; continue; }
        const dim = t === 1 || b === 1;
        line += dim ? `<span class="d">${ch}</span>` : ch;
      }
      lines.push(line);
    }
    return lines.join(NL);
  };
  const MOON = moonGrid();
  const moon = renderMoon(MOON, false);
  const moonHTML = renderMoon(MOON, true);

  // favicon from the same pixels: bright + dim green on black
  const favicon = () => {
    try {
      const g = MOON, S = 32, cell = S / g.length;
      const cv = document.createElement("canvas"); cv.width = S; cv.height = S;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, S, S);
      g.forEach((row, y) => row.forEach((v, x) => {
        if (!v) return;
        ctx.fillStyle = v === 2 ? "#55ff55" : "#00aa00";
        ctx.fillRect(Math.round(x * cell), Math.round(y * cell), Math.ceil(cell), Math.ceil(cell));
      }));
      let link = document.querySelector('link[rel="icon"]');
      if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
      link.type = "image/png"; link.href = cv.toDataURL("image/png");
    } catch (e) { /* no canvas: keep the svg icon */ }
  };

  const ground = (w) => "▀".repeat(w);
  // deterministic scatter of rain glyphs
  const rain = (cols, rows, seed = 7) => {
    let s = seed; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const g = ["░", "▒", "·", "'", "│"];
    const out = [];
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) line += rnd() < 0.045 ? g[Math.floor(rnd() * g.length)] : " ";
      out.push(line);
    }
    return out.join(NL);
  };
  const button = (label) => {
    const w = label.length + 4;
    return `${"▄".repeat(w)}${NL}█  ${label} █<span class="sh">▓</span>${NL}${"▀".repeat(w)}<span class="sh">▓</span>`;
  };
  const spark = (values, target) => {
    const bars = "▁▂▃▄▅▆▇█";
    const all = values.concat(target != null ? [target] : []);
    const min = Math.min(...all), max = Math.max(...all);
    const lvl = (v) => (max === min ? 4 : Math.round(((v - min) / (max - min)) * 7));
    const tl = target != null ? lvl(target) : -1;
    return values.map((v) => { const l = lvl(v); return l === tl ? `<span class="t">${bars[l]}</span>` : bars[l]; }).join("");
  };
  return { logo, moon, moonHTML, moonGrid, favicon, ground, rain, button, spark };
})();

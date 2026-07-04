/** Selection interaction test — the safety net for the selection data structure
 * (pick / accumulate / invert / clear). It drives the real UI: double-click the
 * centre gaussian, read the "선택 N개" panel title, invert, and clear. Picking is
 * pure projection math (independent of the GPU sort), so this is deterministic.
 *
 * Scene (viewer z-up, after the .splat y-down->z-up transform file(x,y,z) ->
 * viewer(x, z, -y); camera sits at the origin looking +y when the AABB centre
 * is the origin):
 *   A  file(0,0,4)  -> viewer(0,4,0)   dead centre, front-most  (red)
 *   B  file(2,0,4)  -> viewer(2,4,0)   offset right             (green)
 *   C  file(-2,0,4) -> viewer(-2,4,0)  offset left              (blue)
 *   bal file(0,0,-4)-> viewer(0,-4,0)  behind camera, tiny — only there to
 *                                      keep the AABB centre at the origin.
 * A double-click at screen centre picks A (1). Invert selects the other three. */
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import zlib from "node:zlib";

const URL = process.env.SMOKE_URL || `http://localhost:${process.env.SMOKE_PORT || 4173}`;

// Minimal PNG centre-pixel reader (8-bit RGB/RGBA, filters 0-4).
function pngCentre(buf) {
  let off = 8, w = 0, h = 0, bpp = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bpp = data[9] === 6 ? 4 : 3; }
    else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    rows.push(line); prev = line;
  }
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const px = rows[cy].subarray(cx * bpp, cx * bpp + 3);
  return [px[0], px[1], px[2]];
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const root = "/opt/pw-browsers";
  if (existsSync(root)) {
    for (const dir of readdirSync(root).filter((d) => /^chromium-\d/.test(d))) {
      const exe = `${root}/${dir}/chrome-linux/chrome`;
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

function makeSplat() {
  const rec = (px, py, pz, s, r, g, b) => {
    const buf = Buffer.alloc(32);
    buf.writeFloatLE(px, 0); buf.writeFloatLE(py, 4); buf.writeFloatLE(pz, 8);
    buf.writeFloatLE(s, 12); buf.writeFloatLE(s, 16); buf.writeFloatLE(s, 20);
    buf[24] = r; buf[25] = g; buf[26] = b; buf[27] = 255;
    buf[28] = 255; buf[29] = 128; buf[30] = 128; buf[31] = 128;
    return buf;
  };
  return Buffer.concat([
    rec(0, 0, 4, 0.5, 255, 0, 0),   // A centre
    rec(2, 0, 4, 0.5, 0, 255, 0),   // B right
    rec(-2, 0, 4, 0.5, 0, 0, 255),  // C left
    rec(0, 0, -4, 0.01, 0, 0, 0),   // balancer (behind camera)
  ]);
}

async function waitForServer(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server never came up at ${url}`);
}

const hasText = (page, re, ms = 15_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), re.source, { timeout: ms });

// One full attempt in a fresh page: load the scene, wait until the red centre
// gaussian actually renders (camera settled → a centre double-click hits A),
// then pick / invert / clear and assert the "선택 N개" panel title.
// Returns { rendered, checks } — `rendered:false` means the frame never came up
// (software-GL/JS-sorter fallback quirk, see render-smoke), so the caller
// retries in a fresh page. With the WASM sorter (CI) the first attempt renders.
async function attempt() {
  // Fresh browser per attempt: a wedged software-GL context can otherwise
  // persist across pages in the same process.
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--use-gl=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 640, height: 600 } });
  try {
    await page.route(/huggingface\.co/, (r) => r.abort());
    await page.goto(URL, { waitUntil: "load" });
    await hasText(page, /오류|error|gaussians/).catch(() => {});
    await page.setInputFiles('input[accept=".ply,.splat,.spz"]', {
      name: "seltest.splat", mimeType: "application/octet-stream", buffer: makeSplat(),
    });
    await hasText(page, /loaded .*gaussians|4 gaussians/).catch(() => {});

    // Precondition: red (A) rendered at centre. Net-zero nudge each iteration to
    // kick the sort without drifting the view.
    let onA = false;
    for (let i = 0; i < 16 && !onA; i++) {
      await page.mouse.move(320, 300); await page.mouse.down();
      await page.mouse.move(340, 300, { steps: 3 }); await page.mouse.move(320, 300, { steps: 3 }); await page.mouse.up();
      await page.waitForTimeout(500);
      const [r, , b] = pngCentre(await page.screenshot());
      onA = r > 150 && b < 100;
    }
    if (!onA) return { rendered: false, checks: [] };

    const checks = [];
    // 1) pick the centre gaussian -> selection of 1 (retry the double-click; its
    // 300ms window can be missed). A non-additive pick always yields exactly {A}.
    let picked = false;
    for (let a = 0; a < 8 && !picked; a++) {
      await page.mouse.dblclick(320, 300);
      picked = await hasText(page, /선택 1개/, 1500).then(() => true).catch(() => false);
    }
    checks.push(["pick front-most -> 선택 1개", picked]);

    // 2) invert -> the other three
    let inverted = false;
    if (picked) {
      await page.getByRole("button", { name: "선택 반전" }).click();
      inverted = await hasText(page, /선택 3개/, 4000).then(() => true).catch(() => false);
    }
    checks.push(["invert -> 선택 3개", inverted]);

    // 3) clear (Esc) -> selection panel gone
    await page.keyboard.press("Escape");
    const cleared = await page.waitForFunction(() => !/선택 \d+개/.test(document.body.innerText), null, { timeout: 8000 })
      .then(() => true).catch(() => false);
    checks.push(["Esc clears selection", cleared]);
    return { rendered: true, checks };
  } finally {
    await browser.close();
  }
}

let code = 1;
try {
  await waitForServer(URL, 30_000);
  console.log(`selection-smoke: server up at ${URL}`);
  let res = { rendered: false, checks: [] };
  const MAX_TRIES = 6; // software-GL insurance; CI's WASM sorter passes on try 1
  for (let tries = 0; tries < MAX_TRIES && !res.rendered; tries++) {
    res = await attempt();
    if (!res.rendered && tries < MAX_TRIES - 1) console.log("selection-smoke: no frame this attempt — retrying in a fresh browser");
  }
  for (const [name, ok] of res.checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!res.rendered) console.log("selection-smoke: FAIL — no frame rendered after retries");
  code = res.rendered && res.checks.every(([, ok]) => ok) ? 0 : 1;
  console.log(code === 0 ? "selection-smoke: PASS" : "selection-smoke: FAIL");
} catch (e) {
  console.log("selection-smoke: FAIL — " + (e?.message || e));
}
process.exit(code);

/** End-to-end render smoke test (the one guard for the whole load → display →
 * LOD → sort → GPU pipeline).
 *
 * Loads a synthetic .splat with an opaque RED splat placed in front of an
 * opaque BLUE one (relative to the fitted origin-camera), screenshots the
 * canvas centre, and asserts red wins. A wrong / stale depth sort — or a broken
 * shader — would show blue (or nothing).
 *
 * Expects a server already serving the app at SMOKE_URL (default
 * http://localhost:4173) — start `npm run preview` (or `dev`) first; CI does
 * this in the workflow. Browser resolution: PLAYWRIGHT_CHROMIUM_PATH env, else
 * the sandbox's pre-installed /opt/pw-browsers chromium, else Playwright's
 * default (the CI container ships one). Exit code is non-zero on failure so CI
 * fails loudly. */
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import zlib from "node:zlib";

const URL = process.env.SMOKE_URL || `http://localhost:${process.env.SMOKE_PORT || 4173}`;

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const root = "/opt/pw-browsers";
  if (existsSync(root)) {
    // Prefer the full chromium-<n> build; skip chromium_headless_shell-<n>.
    for (const dir of readdirSync(root).filter((d) => /^chromium-\d/.test(d))) {
      const exe = `${root}/${dir}/chrome-linux/chrome`;
      if (existsSync(exe)) return exe;
    }
  }
  return undefined; // let Playwright find its bundled browser (CI container)
}

// RED must sit between the origin-camera and BLUE. The camera starts AT the
// origin facing away from the AABB centre, so keep the centre at the origin
// (balancer at viewer -y) and put the pair in front (+y). file(x,y,z) maps to
// viewer(x,z,-y) after the loader's y-down -> z-up transform.
function makeSplat() {
  const rec = (px, py, pz, s, r, g, b) => {
    const buf = Buffer.alloc(32);
    buf.writeFloatLE(px, 0); buf.writeFloatLE(py, 4); buf.writeFloatLE(pz, 8);
    buf.writeFloatLE(s, 12); buf.writeFloatLE(s, 16); buf.writeFloatLE(s, 20);
    buf[24] = r; buf[25] = g; buf[26] = b; buf[27] = 255;
    buf[28] = 255; buf[29] = 128; buf[30] = 128; buf[31] = 128; // identity quat wxyz
    return buf;
  };
  return Buffer.concat([
    rec(0, 0, 5, 0.8, 0, 0, 255),   // BLUE far
    rec(0, 0, 2.5, 0.4, 255, 0, 0), // RED near (in front of blue)
    rec(0, 0, -5, 0.01, 0, 0, 0),   // centre balancer, invisible
  ]);
}

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

async function waitForServer(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`preview server never came up at ${url}`);
}

let code = 1;
try {
  await waitForServer(URL, 30_000);
  console.log(`render-smoke: server up at ${URL}`);
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--use-gl=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 640, height: 600 } });
  page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text()); });
  // Abort the CDN so the first-visit auto-load fails fast and deterministically
  // (independent of whether the runner has internet) — otherwise its async
  // setBuffer(null) can race and wipe the file we upload, and on a networked
  // runner it could even load the Train demo over our synthetic scene.
  await page.route(/huggingface\.co/, (r) => r.abort());
  await page.goto(URL, { waitUntil: "load" });
  // Let the auto-load attempt run and settle before uploading.
  await page.waitForFunction(() => /오류|error|gaussians/i.test(document.body.innerText), null, { timeout: 15_000 }).catch(() => {});
  await page.setInputFiles('input[accept=".ply,.splat,.spz"]', {
    name: "sorttest.splat", mimeType: "application/octet-stream", buffer: makeSplat(),
  });
  await page.waitForFunction(() => /loaded .*gaussians|3 gaussians/i.test(document.body.innerText), null, { timeout: 15_000 }).catch(() => {});

  // One tiny drag forces a real sort pass; nudge back so the net camera
  // rotation is ~zero (repeated one-way drags would rotate the splat off the
  // centre). Then poll the centre pixel until the frame renders (~9s cap) —
  // swiftshader can take a moment to produce the first sorted frame.
  await page.mouse.move(320, 300); await page.mouse.down();
  await page.mouse.move(340, 300, { steps: 4 }); await page.mouse.move(320, 300, { steps: 4 }); await page.mouse.up();
  let r = 0, g = 0, b = 0;
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.waitForTimeout(600);
    ([r, g, b] = pngCentre(await page.screenshot()));
    if (r > 150 || b > 150) break; // something rendered at the centre
  }
  console.log(`centre pixel rgb(${r}, ${g}, ${b})`);
  if (r > 150 && b < 100) { console.log("render-smoke: PASS — red (front) occludes blue (back)"); code = 0; }
  else if (b > 150 && r < 100) console.log("render-smoke: FAIL — blue (back) drawn over red (front)");
  else console.log("render-smoke: FAIL — inconclusive (centre missed the splats?)");
  await browser.close();
} catch (e) {
  console.log("render-smoke: FAIL — " + (e?.message || e));
}
process.exit(code);

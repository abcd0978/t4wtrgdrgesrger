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

const URL = process.env.SMOKE_URL || `http://localhost:${process.env.SMOKE_PORT || 4173}`;

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

const hasText = (page, re) =>
  page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), re.source, { timeout: 15_000 });

let code = 1;
try {
  await waitForServer(URL, 30_000);
  console.log(`selection-smoke: server up at ${URL}`);
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--use-gl=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 640, height: 600 } });
  page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text()); });
  await page.route(/huggingface\.co/, (r) => r.abort());
  await page.goto(URL, { waitUntil: "load" });
  await hasText(page, /오류|error|gaussians/).catch(() => {});
  await page.setInputFiles('input[accept=".ply,.splat,.spz"]', {
    name: "seltest.splat", mimeType: "application/octet-stream", buffer: makeSplat(),
  });
  await hasText(page, /loaded .*gaussians|4 gaussians/).catch(() => {});
  await page.waitForTimeout(800); // let FitCamera place the origin camera

  const checks = [];

  // 1) pick the centre gaussian -> selection of 1
  await page.mouse.dblclick(320, 300);
  const picked = await hasText(page, /선택 1개/).then(() => true).catch(() => false);
  checks.push(["pick front-most -> 선택 1개", picked]);

  // 2) invert -> the other three
  if (picked) {
    await page.getByRole("button", { name: "선택 반전" }).click();
    const inverted = await hasText(page, /선택 3개/).then(() => true).catch(() => false);
    checks.push(["invert -> 선택 3개", inverted]);
  } else {
    checks.push(["invert -> 선택 3개", false]);
  }

  // 3) clear (Esc) -> selection panel gone
  await page.keyboard.press("Escape");
  const cleared = await page.waitForFunction(() => !/선택 \d+개/.test(document.body.innerText), null, { timeout: 8000 })
    .then(() => true).catch(() => false);
  checks.push(["Esc clears selection", cleared]);

  for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  code = checks.every(([, ok]) => ok) ? 0 : 1;
  console.log(code === 0 ? "selection-smoke: PASS" : "selection-smoke: FAIL");
  await browser.close();
} catch (e) {
  console.log("selection-smoke: FAIL — " + (e?.message || e));
}
process.exit(code);

// Headless-Chromium rendering of our OWN public pages → media-kit PDF + share-card PNG.
// Playwright is imported lazily and the browser is cached & reused; any failure (e.g.
// Chromium not installed on the host) throws, which the route turns into a 503 — so the
// app still boots and runs everywhere, the export feature just degrades gracefully.
let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
    } catch { /* fall through to relaunch */ }
    browserPromise = null;
  }
  const { chromium } = await import('playwright');
  browserPromise = chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    .catch(err => { browserPromise = null; throw err; });
  return browserPromise;
}

async function withPage(opts, fn) {
  const browser = await getBrowser();
  const page = await browser.newPage(opts);
  try { return await fn(page); }
  finally { await page.close().catch(() => {}); }
}

async function prep(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch { /* fonts api optional */ }
  await page.waitForTimeout(300); // let entrance transitions settle
}

// Full public profile → A4 PDF (keeps the dark screen styling, not print media).
// `?export=pdf` tells the page to swap the (non-functional in print) interest form
// for a clickable Contact button that links back to the live profile.
export async function renderAthletePdf(url) {
  const target = url + (url.includes('?') ? '&' : '?') + 'export=pdf';
  return withPage({}, async (page) => {
    await prep(page, target);
    await page.emulateMedia({ media: 'screen' });
    return page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14px', bottom: '14px', left: '14px', right: '14px' }
    });
  });
}

// Header card cropped to a shareable PNG (falls back to a viewport shot).
export async function renderAthleteCard(url) {
  return withPage({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 2 }, async (page) => {
    await prep(page, url);
    const el = await page.$('.card');
    return el ? el.screenshot({ type: 'png' }) : page.screenshot({ type: 'png' });
  });
}

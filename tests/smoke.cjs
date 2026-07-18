// Røyktest for nobon.html - ingen backend nødvendig (kjører i "demo-modus",
// SUPABASE_URL er tom i denne fila med mindre du har fylt den inn).
//
// Sjekker det overleveringsnotatet advarer mot spesifikt: en død
// getElementById-referanse eller annen JS-feil som "dreper HELE scriptet"
// og gjør siden blank. Klikker gjennom hovednavigasjonen og et par vanlige
// flyter, og feiler hvis noe kaster en feil i konsollen eller siden blir tom.
//
// Kjøres uten avhengigheter i package.json - bruker Playwright som allerede
// er installert globalt i dette miljøet:
//
//   NODE_PATH=$(npm root -g) node tests/smoke.cjs
//
// Krever en `playwright`-installasjon med Chromium tilgjengelig (se
// PLAYWRIGHT_BROWSERS_PATH). Dette er IKKE en fullverdig testsuite - det er
// en rask sjanity-sjekk som fanger opp "alt ble blankt"-feil automatisk i
// stedet for at noen må klikke gjennom appen manuelt.

const path = require('path');
const { pathToFileURL } = require('url');

function resolvePlaywright() {
  try { return require('playwright'); } catch {}
  const { execSync } = require('child_process');
  const globalRoot = execSync('npm root -g').toString().trim();
  return require(path.join(globalRoot, 'playwright'));
}

async function main() {
  const { chromium } = resolvePlaywright();
  const filePath = path.join(__dirname, '..', 'nobon.html');
  const url = pathToFileURL(filePath).href;

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Uncaught exceptions (pageerror) er alltid en ekte feil i scriptet vårt.
  // console.error derimot fyres også av nettleseren selv for ting som
  // mislykkede nettverkskall (Google Fonts, Supabase-CDN-en) - forventet i
  // et miljø uten nettilgang eller uten Supabase konfigurert, og ikke noe
  // denne testen skal si ifra om. Vi ignorerer bare tydelige
  // ressurslastings-feil; alt annet console.error (f.eks. fra vår egen
  // console.error(...) i feilhåndteringen) telles fortsatt med.
  const IGNORER = /Failed to load resource|net::ERR_/i;
  const feil = [];
  page.on('pageerror', (err) => feil.push('pageerror: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !IGNORER.test(msg.text())) feil.push('console.error: ' + msg.text());
  });

  console.log('Åpner ' + url);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(300);   // la evt. async init (Supabase-sesjon osv.) roe seg

  await sjekkIkkeBlank(page, 'ved oppstart (finn-hjelp)');

  var sider = [
    ['finn-oppdrag', 'Finn oppdrag'],
    ['finn-hjelper', 'Finn hjelper'],
    ['legg-ut', 'Legg ut oppdrag'],
    ['meldinger', 'Meldinger'],
    ['min-konto', 'Min konto'],
    ['logg-inn', 'Logg inn'],
    ['lag-bruker', 'Lag bruker'],
  ];
  for (const [id, navn] of sider) {
    await page.evaluate((sideId) => window.visSide(sideId), id);
    await page.waitForTimeout(80);
    await sjekkIkkeBlank(page, 'på siden "' + navn + '" (#' + id + ')');
  }

  // Et par interaktive flyter som treffer mye av scriptet uten å trenge en server.
  await page.evaluate(() => window.visKategori('handverker'));
  await page.waitForTimeout(80);
  await sjekkIkkeBlank(page, 'i kategori-visningen (visKategori)');

  await page.evaluate(() => { window.visSide('finn-oppdrag'); window.visBla(); });
  await page.waitForTimeout(150);
  await sjekkIkkeBlank(page, 'i swipe-visningen (visBla)');

  await browser.close();

  if (feil.length) {
    console.error('\nRøyktest FEILET - ' + feil.length + ' feil funnet:');
    feil.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('\nRøyktest OK - ingen JS-feil, ingen side ble blank.');
}

async function sjekkIkkeBlank(page, hvor) {
  const harInnhold = await page.evaluate(() => {
    var synlig = Array.from(document.querySelectorAll('.side')).find(function (el) {
      return el.style.display !== 'none';
    });
    return !!synlig && synlig.textContent.trim().length > 0;
  });
  if (!harInnhold) {
    throw new Error('Siden ble blank ' + hvor + ' - se etter en død getElementById-referanse.');
  }
}

main().catch((err) => {
  console.error('Røyktest krasjet:', err);
  process.exit(1);
});

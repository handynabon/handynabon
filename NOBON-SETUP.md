# Nobon — oppsett

`nobon.html` er Nobon-prototypen (se overleveringsnotatet) koblet til en ekte
backend på [Supabase](https://supabase.com): innlogging, delt database,
bildelagring, og en skisse til Vipps-betaling. `index.html` (Handynabon) er
en separat, urelatert bestillingsside og er ikke rørt av dette arbeidet.

**Ingen av dette er testet mot et ekte Supabase- eller Vipps-miljø** — jeg
(Claude) har ikke tilgang til dine nøkler/prosjekt, så alt under er skrevet
etter dokumentasjonen og kodens egen logikk, ikke verifisert live. Gå
gjennom stegene under selv og test grundig før noe av dette møter ekte
brukere eller ekte penger.

## 1. Opprett Supabase-prosjekt og kjør skjemaet

1. Opprett et gratis prosjekt på [supabase.com](https://supabase.com).
2. Gå til **SQL Editor → New query**, lim inn hele `supabase-schema.sql`, og
   kjør den. Den oppretter:
   - `profiler`, `oppdrag`, `interesse`, `meldinger`, `betalinger` — med
     Row Level Security-policyer som sikrer at folk bare kan lese/endre det
     de faktisk skal ha tilgang til.
   - En trigger som lager en `profiler`-rad automatisk når noen registrerer
     seg (fylt fra `navn`/`tlf`/`roller` som sendes inn i `sb.auth.signUp`).
   - To Storage-buckets: `avatarer` og `oppdragsbilder` (begge offentlig
     lesbare, men bare eieren kan laste opp til sin egen mappe).
3. Gå til **Project Settings → API** og kopier **Project URL** og
   **anon public key**. Åpne `nobon.html`, finn denne blokken nær toppen av
   `<script>`-taggen, og fyll inn:

   ```js
   var SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   var SUPABASE_ANON_KEY = 'din-anon-public-key';
   ```

   Begge er trygge å ha i frontend-koden — anon key gir ingen tilgang alene,
   det er RLS-policyene i skjemaet som bestemmer hva som faktisk er lov.
   **Legg aldri `service_role`-nøkkelen i nobon.html** — den omgår RLS helt
   og hører hjemme kun i Edge Functions (se under).

4. (Anbefalt) Under **Authentication → Providers → Email**, la
   "Confirm email" stå på.
5. Test: lag en bruker, bekreft e-posten, logg inn, legg ut et oppdrag, og
   sjekk i **Table Editor** at det faktisk dukker opp i `oppdrag`-tabellen.

## 2. Hva er ekte nå

- **Innlogging** (`sb.auth.signUp` / `signInWithPassword`): passord hashes
  og sesjoner håndteres av Supabase, ikke av denne fila. Overlever
  sideoppdatering.
- **Delt database (steg 2)**: `JOBB`, `H`, `MINE` og `FATT` fylles fra
  `oppdrag`/`profiler`/`interesse`/`meldinger` når `SUPABASE_URL` er satt,
  i stedet for de hardkodede demo-arrayene. Et oppdrag du legger ut dukker
  nå faktisk opp for andre. Høyre-swipe ("interessert") og "godta hjelper"
  skriver til databasen. Se `lastJobb`, `lastHjelpere`, `lastMineOppdrag`,
  `lastFatt` i `<script>`-blokken.
- **Bildelagring (steg 3)**: profilbilde (Min konto) og oppdragsbilder
  (Legg ut oppdrag) lastes opp til Supabase Storage og lagres som ekte
  URL-er, ikke blob-URL-er som forsvinner ved refresh.
- **Sikkerhet**: alt brukerskrevet innhold (navn, oppdragstekst, meldinger)
  går gjennom `escapeHtml()` før det settes med `innerHTML`, så ingen kan
  lagre en tittel/melding som inneholder kjørbar HTML/JS (lagret XSS) —
  relevant nå som dette faktisk er delt mellom brukere.

- **Hjelperprofiler kan redigeres**: Min konto har nå en «Rediger
  hjelperprofil»-knapp (vises for kontoer med hjelper-rollen) for å sette
  kategori, tjenester, sted og timepris — feltene registreringsskjemaet
  aldri spurte om. Skriver til `profiler` og laster `H` på nytt med en gang.
- **Glemt/endre passord**: «Glemt passord?» på innloggingssiden sender en
  e-post via `sb.auth.resetPasswordForEmail`; lenken i e-posten fører
  tilbake til siden og åpner automatisk et «lag nytt passord»-vindu
  (lytter på `PASSWORD_RECOVERY`-hendelsen). Innloggede brukere kan også
  bytte passord direkte fra Min konto.
- **Meldinger er sanntid**: en åpen samtale abonnerer på nye rader i
  `meldinger` via Supabase Realtime (`lyttPaSamtale()`), så et svar dukker
  opp med en gang i stedet for bare ved neste sidenavigasjon. Krever at
  Realtime er skrudd på for tabellen — skjemaet gjør det automatisk.
- **Grunnleggende serversikring**: lengdebegrensninger på tekstfelt
  (tittel, beskrivelse, meldinger, navn osv.) håndheves nå som
  databasebegrensninger, ikke bare i skjemaet i nettleseren. Storage-bøttene
  for bilder har en filstørrelsesgrense og godtar kun bildefiler — håndhevet
  av Supabase Storage selv, ikke bare `accept="image/*"` i skjemaet (som er
  trivielt å omgå). Spørringer mot databasen har også fått fornuftige
  øvre grenser (`.limit(...)`) så en enkelt side ikke prøver å hente
  ubegrenset mange rader.
- **Vurderinger/anmeldelser**: når et oppdrag er merket ferdig kan
  oppdragsgiveren gi hjelperen 1–5 stjerner og en valgfri kommentar på
  oppdragssiden. `profiler.rating` oppdateres automatisk av en
  databasetrigger (`oppdater_rating`) — ikke av klientkoden — så tallet er
  alltid et ekte snitt av `vurderinger`-tabellen. Én vurdering per
  fullført oppdrag, håndhevet av en RLS-policy (kan bare vurdere hjelperen
  på et oppdrag du selv eier og som faktisk er `ferdig`).
- **Endre e-post / slette konto**: lagt til i Min konto, ved siden av
  passordbytte. Sletting går via en egen Edge Function
  (`supabase/functions/slett-konto`) siden en vanlig klient ikke kan slette
  sin egen `auth.users`-rad selv — det krever `service_role`. Krever at
  brukeren skriver "SLETT" for å bekrefte (destruktiv handling).
- **Admin-panel**: en «Admin»-knapp i Min konto (kun synlig for admin-
  kontoer) åpner en side med to lister — alle oppdrag (med sletteknapp) og
  alle brukere (med sperr/opphev sperring). Sperrede brukere kan ikke
  legge ut oppdrag, melde interesse eller sende meldinger — håndhevet av
  RLS-policyene, ikke bare skjult i grensesnittet. Se punkt 3 under for
  hvordan du gjør en bruker til admin.
- **Ekte avstand**: km vises nå kun når den faktisk er kjent, aldri
  gjettet/hardkodet — se punkt 4 for hvordan geokoding og brukerposisjon
  henger sammen. Finn oppdrag har også fått et kategori-filter (piller,
  flervalg).

## 3. Bli admin (kreves manuelt, med vilje)

Ingen har admin-tilgang som standard, og det finnes ingen «gjør til
admin»-knapp noe sted i appen — bevisst, siden det ville vært en alvorlig
sikkerhetsbrist om en vanlig bruker kunne gjøre seg selv til admin. For å
gjøre en konto til admin:

1. Registrer en vanlig bruker i appen som normalt.
2. Kjør i Supabase sin SQL Editor:
   ```sql
   update public.profiler set er_admin = true where epost = 'din@epost.no';
   ```
3. Logg ut og inn igjen (eller last siden på nytt) — «Admin»-knappen dukker
   opp i Min konto.

`er_admin`/`sperret`-feltene på `profiler` kan ikke settes gjennom en vanlig
`update`-forespørsel fra klienten, selv om RLS i utgangspunktet lar deg
oppdatere din egen rad — en database-trigger
(`profiler_beskytt_adminfelter`) tilbakestiller de to feltene med mindre den
som gjør endringen allerede er admin. Selve admin-handlingene (slette et
oppdrag, sperre en bruker) går gjennom to egne databasefunksjoner
(`admin_slett_oppdrag`, `admin_sperr_bruker`) som sjekker admin-status på
serveren før de gjør noe, uansett hva klienten sender.

## 4. Ekte avstand

Avstand er nå reell, ikke det gamle hardkodede `km`-tallet fra prototypen:

- `oppdrag` og `profiler` har `lat`/`lng`-kolonner. Når noen legger ut et
  oppdrag eller lagrer stedet sitt i hjelperprofilen, geokodes teksten
  (`geokod(sted)`) via [Nominatim](https://nominatim.org/) (OpenStreetMap,
  gratis, ingen nøkkel) og lagres som koordinater.
- Når en besøkende skriver i «Hvor er du»-feltet (på forsiden eller Finn
  hjelper), geokodes DET også (avmerket 700ms etter siste tastetrykk, og
  cachet per stedstekst i økten) og settes som `BRUKER_POS`.
- Så snart begge finnes, regner `avstandKm`/`avstandTil` (Haversine,
  luftlinje) ut ekte kilometer, og `stedLinje()` viser den overalt
  (jobbkort, swipe-kort, oppdragsdetalj, hjelperkort, søkere) — automatisk,
  ingen ekstra kode trengs andre steder. Avstandsskyveren og
  «sorter på avstand» bruker de samme funksjonene.
- Er posisjonen til en av de to ukjent (f.eks. et oppdrag lagt ut før
  `sted` ga treff hos Nominatim, eller ingen har skrevet noe i
  «Hvor er du»), vises bare stedsnavnet — aldri et gjettet/falskt tall.
  Slikt uten kjent avstand ekskluderes heller ikke av avstandsfilteret
  (bare det som er trygt bekreftet UTENFOR grensen filtreres bort), og
  synker til bunnen ved sortering på avstand.

**Merk om Nominatim i produksjon:** dette kalles direkte fra nettleseren.
Nominatim sine bruksvilkår ber om maks ~1 kall/sekund og at
tyngre/produksjonsbruk går via egen server, ikke rett fra klienten til
deres offentlige tjeneste. Helt greit for en prototype/lite prosjekt; hvis
Nobon får mye trafikk, flytt `geokod()` bak en Edge Function (samme mønster
som Vipps-kallene i `supabase/functions`) og vurder en betalt
geokodingstjeneste.

En kategori-filter-rad (piller) er også lagt til på Finn oppdrag-siden —
viser bare kategorier som faktisk har åpne oppdrag, flervalg.

## 5. Vipps (steg 4) — skisse, ikke en ferdig løsning

Betalingskallet går nå via tre Supabase Edge Functions i stedet for
direkte fra nettleseren (`client_secret` kan aldri ligge i `nobon.html`):

- `supabase/functions/vipps-init` — oppretter en betaling hos Vipps og gir
  klienten en `redirectUrl` å sende brukeren til.
- `supabase/functions/vipps-status` — henter den *autoritative* statusen
  direkte fra Vipps sitt API når brukeren kommer tilbake (aldri stol på at
  nettleseren/retur-URL-en sier "betalt").
- `supabase/functions/vipps-webhook` — mottar hendelser fra Vipps
  uavhengig av om brukeren noensinne kommer tilbake til siden, og
  bekrefter alltid mot Vipps sitt API før noe lagres som betalt.

**Dette er ikke testet og krever din egen innsats før det kan flytte ekte
penger:**

1. Registrer foretak og søk om Vipps-avtale på
   [portal.vipps.no](https://portal.vipps.no) (krever KYC/AML-godkjenning —
   tar noen dager). Vipps inngår ikke avtale med privatpersoner.
2. Du får fire nøkler: `client_id`, `client_secret`,
   `Ocp-Apim-Subscription-Key`, Merchant Serial Number.
3. Deploy funksjonene: `supabase functions deploy vipps-init vipps-status vipps-webhook`
4. Sett secrets (`supabase secrets set ...`):
   `VIPPS_CLIENT_ID`, `VIPPS_CLIENT_SECRET`, `VIPPS_SUBSCRIPTION_KEY`,
   `VIPPS_MERCHANT_SERIAL_NUMBER`, `VIPPS_API_BASE` (`apitest.vipps.no` i
   test, `api.vipps.no` i produksjon), `SITE_URL` (der `nobon.html` er
   hostet), `VIPPS_WEBHOOK_SECRET` (se punkt 6).
   `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` settes
   automatisk av Supabase.
5. **Test i `apitest.vipps.no` først**, aldri direkte i produksjon.
6. Registrer webhook-URL-en (`.../functions/v1/vipps-webhook`) hos Vipps
   via deres Webhooks API for å få en webhook-hemmelighet.
   `vipps-webhook/index.ts` har en best-effort signatursjekk av
   webhook-kallet, men jeg kunne ikke verifisere det nøyaktige
   signaturformatet uten tilgang til et testmiljø — les advarselen øverst i
   den fila før du stoler på den. Funksjonen er uansett bygget slik at den
   ALDRI setter en betaling til "betalt" basert på webhook-bodyen alene;
   den slår alltid opp den ekte statusen hos Vipps' API først.
7. Utbetaling videre til hjelperen er en egen, strengere sak (Nobon blir
   mellomledd) — ikke bygget her. Få betaling *inn* til å virke først, som
   overleveringsnotatet sier.

## 6. Automatisk røyktest

`tests/smoke.cjs` er ikke en fullverdig testsuite, men en rask sjekk som
fanger opp nøyaktig den feilklassen overleveringsnotatet advarer mot: en død
`getElementById`-referanse (eller annen JS-feil) som "dreper HELE scriptet"
og gjør en side blank. Den åpner `nobon.html` lokalt i Chromium (ingen
backend eller nettilgang nødvendig — kjører i demo-modus), klikker gjennom
hovednavigasjonen og et par flyter (kategori, swipe-visning), og feiler hvis
noe kaster en feil eller en side blir tom.

Kjør den med Playwright, som allerede er installert globalt i dette miljøet:

```
NODE_PATH=$(npm root -g) node tests/smoke.cjs
```

Kjør den etter enhver endring i `nobon.html`, spesielt etter å ha lagt til
eller fjernet et element med en `id` — det er nøyaktig den typen feil den
er laget for å fange.

## 7. Bevisst ikke bygget

- **Ingen utbetaling til hjelperen.** Nobon ville blitt et mellomledd for
  ekte pengeoverføringer til tredjepart, som typisk krever egen
  regulatorisk/juridisk avklaring (utover det en Vipps-betalingsavtale
  alene dekker). Jeg har latt være å dikte opp en utbetalingsflyt for det
  uten et klart mandat til det — få betaling *inn* til å virke og verifisert
  først, som overleveringsnotatet selv sier.
- **Ingen paginering utover `.limit(...)`** — lista viser alt den får i ett
  jafs opp til den øvre grensen, ikke side for side. Fint på prototype-skala.
- **`nobon.html` er ikke hostet noe sted** — du må selv publisere den
  (Vercel, Netlify, et vanlig webhotell, e.l.; den trenger ikke noe
  byggesteg) og sette `SITE_URL` i Edge Function-secrets deretter.
- Alt merket "ikke testet" i punkt 1 og 5: jeg har ikke hatt tilgang til et
  ekte Supabase- eller Vipps-miljø for å faktisk kjøre noe av dette.
  Røyktesten i punkt 6 dekker bare demo-modus (uten Supabase konfigurert),
  og fanger ikke opp feil i selve databasepolicyene/RPC-funksjonene
  (`admin_slett_oppdrag`, `admin_sperr_bruker`, `oppdater_rating` osv.) —
  test admin-panelet og vurderingene manuelt mot et ekte prosjekt før bruk.

## Filoversikt

| Fil | Hva |
|---|---|
| `nobon.html` | Selve appen |
| `supabase-schema.sql` | Kjøres i Supabase SQL Editor: tabeller, RLS, storage-buckets |
| `supabase/functions/vipps-init` | Starter en Vipps-betaling |
| `supabase/functions/vipps-status` | Henter autoritativ betalingsstatus fra Vipps |
| `supabase/functions/vipps-webhook` | Mottar hendelser fra Vipps |
| `supabase/functions/slett-konto` | Sletter en brukers konto (krever service_role) |
| `tests/smoke.cjs` | Røyktest, se punkt 6 |

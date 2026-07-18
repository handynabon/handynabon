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

## 3. Kjent begrensning: ekte avstand

Avstand (`km`) er ikke ekte for database-baserte rader —
prototypens faste avstandstall var uansett bare pynt, og ekte geografisk
avstand krever geokoding (adresse/postnummer → koordinater), som er utenfor
denne oppgaven. Avstandsfilteret virker fortsatt for demodata; for ekte
rader vises ikke avstand, og "uansett avstand" må velges for å se dem i
avstandsfiltrerte lister.

## 4. Vipps (steg 4) — skisse, ikke en ferdig løsning

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

## 5. Fortsatt ikke gjort

- **Ingen utbetaling til hjelperen** (se punkt 7 over) og **ingen
  vurderinger/anmeldelser** — `rating` blir stående som `null` ("Ny hjelper")
  til noen bygger en anmeldelses-funksjon; det finnes ingen skjerm for det ennå.
- **Ingen paginering** i grensesnittet — spørringene har en øvre grense
  (se over) så de ikke er ubegrensede, men lista viser alt den får i ett
  jafs, ikke side for side. Fint på prototype-skala, ikke ved tusenvis av rader.
- **Ingen kontoinnstillinger for e-post eller sletting av konto** — bare
  passordbytte er lagt til.
- **Ingen admin-/moderasjonsverktøy** for å fjerne upassende oppdrag eller
  meldinger.
- **Ingen automatiske tester.**
- **`nobon.html` er ikke hostet noe sted** — du må selv publisere den
  (Vercel, Netlify, et vanlig webhotell, e.l.) og sette `SITE_URL` i
  Edge Function-secrets deretter.
- Alt merket "ikke testet" i punkt 1 og 4 over: jeg har ikke hatt tilgang
  til et ekte Supabase- eller Vipps-miljø for å faktisk kjøre noe av dette.

## Filoversikt

| Fil | Hva |
|---|---|
| `nobon.html` | Selve appen |
| `supabase-schema.sql` | Kjøres i Supabase SQL Editor: tabeller, RLS, storage-buckets |
| `supabase/functions/vipps-init` | Starter en Vipps-betaling |
| `supabase/functions/vipps-status` | Henter autoritativ betalingsstatus fra Vipps |
| `supabase/functions/vipps-webhook` | Mottar hendelser fra Vipps |

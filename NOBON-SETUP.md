# Nobon — oppsett av ekte innlogging

`nobon.html` er Nobon-prototypen (se overleveringsnotatet) med ekte
autentisering koblet på via [Supabase Auth](https://supabase.com/auth).
Resten av appen (delte oppdrag/hjelpere, meldinger, bildelagring, Vipps)
er fortsatt lokale demodata, som beskrevet i overleveringsnotatet — det er
et eget stykke arbeid (steg 2–4 der).

## Hva er gjort

- Ekte registrering (`sb.auth.signUp`) og innlogging (`sb.auth.signInWithPassword`).
  Supabase står for passord-hashing, e-postbekreftelse og sesjoner — ingen
  passord lagres eller logges noe sted i denne fila.
- Innlogging overlever sideoppdatering (sesjonen hentes med `sb.auth.getSession()`
  og holdes oppdatert med `sb.auth.onAuthStateChange`).
- Logg ut kaller `sb.auth.signOut()`.
- Navn/telefon/roller lagres som `user_metadata` på Supabase-brukeren ved
  registrering — ingen egen databasetabell er nødvendig for at innlogging skal virke.
- Alt som nå kan inneholde brukerskrevet tekst (kontonavn, e-post, telefon,
  overskrift/beskrivelse på oppdrag du legger ut, meldinger i samtaler) går
  gjennom en `escapeHtml()`-funksjon før det settes med `innerHTML`, slik at
  ingen kan lagre en "jobbtittel" eller melding som inneholder kjørbar HTML/JS
  (lagret XSS). Dette er spesielt viktig fram mot steg 2, når disse feltene
  begynner å deles mellom ulike brukere via en database.

## Sett opp ditt eget Supabase-prosjekt

1. Opprett et gratis prosjekt på [supabase.com](https://supabase.com).
2. Gå til **Project Settings → API** og kopier **Project URL** og **anon public key**.
3. Åpne `nobon.html`, finn denne blokken nær toppen av `<script>`-taggen,
   og fyll inn dine egne verdier:

   ```js
   var SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   var SUPABASE_ANON_KEY = 'din-anon-public-key';
   ```

   Begge er trygge å ha i frontend-koden — anon key gir ingen tilgang alene.
   **Legg aldri `service_role`-nøkkelen her**, verken i denne fila eller noe
   annet som havner i nettleseren; den omgår Row Level Security fullstendig.

4. (Anbefalt) Under **Authentication → Providers → Email**, la
   "Confirm email" stå på, slik at folk må bekrefte e-posten sin før de kan
   logge inn.
5. Test: åpne `nobon.html`, lag en bruker, sjekk at bekreftelses-e-posten
   kommer, bekreft, og logg inn. Last siden på nytt — du skal fortsatt være
   innlogget.

## Fortsatt ikke gjort (utenfor denne oppgaven)

Dette var avgrenset til innlogging og sikkerhet. Resten av overleveringsnotatets
plan står ved lag:

- **Steg 2 — database**: `JOBB`, `H`, `MINE`, `FATT` og meldinger er fortsatt
  hardkodede/øktbaserte arrays, ikke Supabase-tabeller. Nye oppdrag når
  fortsatt ikke andre brukere. Når dette gjøres, sørg for at Row Level
  Security skrus på slik at folk bare kan endre sitt eget, og bruk
  `escapeHtml()` (finnes allerede i fila) på alt som rendres fra de nye
  tabellene.
- **Steg 3 — bildelagring**: profilbilde og oppdragsbilder bruker fortsatt
  `URL.createObjectURL` (blob-URL-er som forsvinner ved oppdatering).
- **Steg 4 — Vipps**: betalingsskjermen finnes, men er ikke koblet til noe.
  Krever registrert foretak og at Vipps-kallene legges i en backend
  (Supabase Edge Function) — `client_secret` kan aldri ligge i denne fila.

## `index.html`

`index.html` (Handynabon) er en separat, urelatert bestillingsside og er
ikke rørt av dette arbeidet.

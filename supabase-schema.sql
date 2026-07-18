-- Nobon — databaseskjema for Supabase (steg 2 + 3 i overleveringsnotatet)
--
-- Kjør denne i Supabase-prosjektet ditt: Dashboard → SQL Editor → New query
-- → lim inn hele fila → Run. Trygt å kjøre på nytt (bruker "if not exists"
-- der det går), men sletter ingenting eksisterende av seg selv.
--
-- Rekkefølge betyr noe her: profiler før oppdrag, oppdrag før interesse/meldinger.

-- =========================================================
-- 1. PROFILER — offentlig profil knyttet 1:1 til auth.users
-- =========================================================
create table if not exists public.profiler (
  id              uuid primary key references auth.users(id) on delete cascade,
  navn            text not null check (char_length(navn) between 1 and 120),
  epost           text not null,
  tlf             text check (char_length(tlf) <= 20),
  roller          text[] not null default '{}',   -- 'kunde' og/eller 'hjelper'
  bilde_url       text,
  pro             boolean not null default false,
  sted            text check (char_length(sted) <= 200),
  kategori        text,                            -- KAT-id, f.eks. 'handverker'
  tags            text[] not null default '{}' check (array_length(tags,1) is null or array_length(tags,1) <= 20),    -- underkategorier hjelperen tilbyr
  pris            numeric check (pris is null or (pris >= 0 and pris < 1000000)),                          -- kr/t
  rating          numeric check (rating is null or (rating >= 0 and rating <= 5)),                          -- null = ingen vurderinger ennå (steg for seg selv, ikke bygget her)
  antall_oppdrag  integer not null default 0,       -- oppdatert av trigger under
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.profiler enable row level security;

drop policy if exists "profiler er offentlig lesbare" on public.profiler;
create policy "profiler er offentlig lesbare"
  on public.profiler for select
  using (true);

drop policy if exists "en bruker kan opprette sin egen profil" on public.profiler;
create policy "en bruker kan opprette sin egen profil"
  on public.profiler for insert
  with check (auth.uid() = id);

drop policy if exists "en bruker kan endre sin egen profil" on public.profiler;
create policy "en bruker kan endre sin egen profil"
  on public.profiler for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Oppretter automatisk en profiler-rad når noen bekrefter e-posten sin,
-- med navn/tlf/roller fra user_metadata (satt av sb.auth.signUp i nobon.html).
create or replace function public.ny_bruker_profil()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiler (id, navn, epost, tlf, roller)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'navn', new.email),
    new.email,
    new.raw_user_meta_data->>'tlf',
    coalesce(
      (select array_agg(x) from jsonb_array_elements_text(new.raw_user_meta_data->'roller') as x),
      '{}'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.ny_bruker_profil();

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.ny_bruker_profil();

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists profiler_touch on public.profiler;
create trigger profiler_touch before update on public.profiler
  for each row execute function public.touch_updated_at();


-- =========================================================
-- 2. OPPDRAG — jobber lagt ut av en kunde
-- =========================================================
create table if not exists public.oppdrag (
  id            bigint generated always as identity primary key,
  -- Begge peker til profiler(id), ikke auth.users(id) direkte - selv om
  -- profiler.id ER auth.users.id (1:1, satt opp av triggeren over). Det gjør
  -- at Supabase/PostgREST kan bygge inn navn osv. via foreign-key-embedding
  -- (f.eks. .select('*, hjelper:profiler!hjelper_id(navn)')).
  bruker_id     uuid not null references public.profiler(id) on delete cascade,
  hjelper_id    uuid references public.profiler(id) on delete set null,
  tittel        text not null check (char_length(tittel) between 1 and 200),
  kategori      text not null,     -- KAT-id
  underkategori text,
  sted          text not null check (char_length(sted) <= 200),
  pris          text check (char_length(pris) <= 60),              -- fritekst, f.eks. "2 500 kr" eller "400 kr/t" (som i prototypen)
  beskrivelse   text check (char_length(beskrivelse) <= 4000),
  bilder        text[] not null default '{}' check (array_length(bilder,1) is null or array_length(bilder,1) <= 6),
  status        text not null default 'apen' check (status in ('apen','tildelt','ferdig')),
  created_at    timestamptz not null default now()
);

alter table public.oppdrag enable row level security;

drop policy if exists "apne oppdrag er offentlig lesbare" on public.oppdrag;
create policy "apne oppdrag er offentlig lesbare"
  on public.oppdrag for select
  using (
    status = 'apen'
    or bruker_id = auth.uid()
    or hjelper_id = auth.uid()
  );

drop policy if exists "en innlogget bruker kan legge ut oppdrag" on public.oppdrag;
create policy "en innlogget bruker kan legge ut oppdrag"
  on public.oppdrag for insert
  with check (auth.uid() = bruker_id);

drop policy if exists "eier eller tildelt hjelper kan endre oppdraget" on public.oppdrag;
create policy "eier eller tildelt hjelper kan endre oppdraget"
  on public.oppdrag for update
  using (auth.uid() = bruker_id or auth.uid() = hjelper_id)
  with check (auth.uid() = bruker_id or auth.uid() = hjelper_id);

-- Teller opp antall_oppdrag på hjelperens profil når et oppdrag merkes ferdig.
create or replace function public.oppdrag_ferdig_teller()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'ferdig' and old.status <> 'ferdig' and new.hjelper_id is not null then
    update public.profiler set antall_oppdrag = antall_oppdrag + 1 where id = new.hjelper_id;
  end if;
  return new;
end;
$$;
drop trigger if exists oppdrag_ferdig on public.oppdrag;
create trigger oppdrag_ferdig after update on public.oppdrag
  for each row execute function public.oppdrag_ferdig_teller();


-- =========================================================
-- 3. INTERESSE — en hjelper har meldt interesse for et oppdrag
--    (høyre-swipe i "Finn oppdrag"). Dette er "søkere" i prototypen.
-- =========================================================
create table if not exists public.interesse (
  id           bigint generated always as identity primary key,
  oppdrag_id   bigint not null references public.oppdrag(id) on delete cascade,
  hjelper_id   uuid not null references public.profiler(id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (oppdrag_id, hjelper_id)
);

alter table public.interesse enable row level security;

drop policy if exists "eier av oppdraget eller hjelperen selv kan se interesse" on public.interesse;
create policy "eier av oppdraget eller hjelperen selv kan se interesse"
  on public.interesse for select
  using (
    hjelper_id = auth.uid()
    or exists (select 1 from public.oppdrag o where o.id = oppdrag_id and o.bruker_id = auth.uid())
  );

drop policy if exists "en hjelper kan melde interesse for seg selv" on public.interesse;
create policy "en hjelper kan melde interesse for seg selv"
  on public.interesse for insert
  with check (hjelper_id = auth.uid());

drop policy if exists "en hjelper kan trekke egen interesse" on public.interesse;
create policy "en hjelper kan trekke egen interesse"
  on public.interesse for delete
  using (hjelper_id = auth.uid());


-- =========================================================
-- 4. MELDINGER — én samtale per (oppdrag, hjelper)-par
-- =========================================================
create table if not exists public.meldinger (
  id           bigint generated always as identity primary key,
  oppdrag_id   bigint not null references public.oppdrag(id) on delete cascade,
  hjelper_id   uuid not null references public.profiler(id) on delete cascade,
  avsender_id  uuid not null references auth.users(id),
  tekst        text not null check (char_length(tekst) between 1 and 2000),
  lest         boolean not null default false,
  created_at   timestamptz not null default now()
);

alter table public.meldinger enable row level security;

drop policy if exists "begge parter i samtalen kan lese meldingene" on public.meldinger;
create policy "begge parter i samtalen kan lese meldingene"
  on public.meldinger for select
  using (
    hjelper_id = auth.uid()
    or exists (select 1 from public.oppdrag o where o.id = oppdrag_id and o.bruker_id = auth.uid())
  );

drop policy if exists "begge parter kan sende melding i egen samtale" on public.meldinger;
create policy "begge parter kan sende melding i egen samtale"
  on public.meldinger for insert
  with check (
    avsender_id = auth.uid()
    and (
      hjelper_id = auth.uid()
      or exists (select 1 from public.oppdrag o where o.id = oppdrag_id and o.bruker_id = auth.uid())
    )
  );

drop policy if exists "begge parter kan markere egne meldinger som lest" on public.meldinger;
create policy "begge parter kan markere egne meldinger som lest"
  on public.meldinger for update
  using (
    hjelper_id = auth.uid()
    or exists (select 1 from public.oppdrag o where o.id = oppdrag_id and o.bruker_id = auth.uid())
  )
  with check (true);

-- Skru på Realtime for meldinger, slik at en åpen samtale i nobon.html
-- oppdaterer seg selv med en gang (se lyttPaSamtale()) - respekterer RLS
-- over, så folk får bare push for samtaler de faktisk har tilgang til.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meldinger'
  ) then
    alter publication supabase_realtime add table public.meldinger;
  end if;
end $$;


-- =========================================================
-- 5. STORAGE — profilbilder og oppdragsbilder (steg 3)
-- =========================================================
-- file_size_limit er i bytes. allowed_mime_types håndheves av Supabase Storage
-- selv (ikke bare klientkoden), så en forfalsket filendelse holder ikke.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatarer', 'avatarer', true, 5242880, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('oppdragsbilder', 'oppdragsbilder', true, 8388608, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "alle kan se profilbilder" on storage.objects;
create policy "alle kan se profilbilder"
  on storage.objects for select
  using (bucket_id = 'avatarer');

drop policy if exists "en bruker kan laste opp eget profilbilde" on storage.objects;
create policy "en bruker kan laste opp eget profilbilde"
  on storage.objects for insert
  with check (bucket_id = 'avatarer' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "en bruker kan erstatte eget profilbilde" on storage.objects;
create policy "en bruker kan erstatte eget profilbilde"
  on storage.objects for update
  using (bucket_id = 'avatarer' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "alle kan se oppdragsbilder" on storage.objects;
create policy "alle kan se oppdragsbilder"
  on storage.objects for select
  using (bucket_id = 'oppdragsbilder');

drop policy if exists "en innlogget bruker kan laste opp oppdragsbilder" on storage.objects;
create policy "en innlogget bruker kan laste opp oppdragsbilder"
  on storage.objects for insert
  with check (bucket_id = 'oppdragsbilder' and (storage.foldername(name))[1] = auth.uid()::text);


-- =========================================================
-- 6. BETALINGER — Vipps-betalinger (steg 4)
--
-- Denne tabellen skrives KUN av Edge Functions (service_role), aldri direkte
-- fra nettleseren - derfor har den ingen insert/update-policy for vanlige
-- brukere. "Stol aldri på at nettleseren sier betalt" (se overleveringsnotatet):
-- status her kommer fra Vipps sitt webhook-kall eller et direkte statuskall
-- mot Vipps sitt API, aldri fra klienten selv.
-- =========================================================
create table if not exists public.betalinger (
  id            uuid primary key default gen_random_uuid(),
  oppdrag_id    bigint not null references public.oppdrag(id) on delete cascade,
  bruker_id     uuid not null references public.profiler(id),
  hjelper_id    uuid not null references public.profiler(id),
  belop_ore     integer not null,                 -- beløp i øre (Vipps sin enhet)
  vipps_referanse text unique,                     -- Vipps sin "reference" for betalingen
  status        text not null default 'opprettet' check (status in ('opprettet','betalt','feilet','kansellert')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.betalinger enable row level security;

drop policy if exists "kunde og hjelper kan se egen betaling" on public.betalinger;
create policy "kunde og hjelper kan se egen betaling"
  on public.betalinger for select
  using (bruker_id = auth.uid() or hjelper_id = auth.uid());

drop trigger if exists betalinger_touch on public.betalinger;
create trigger betalinger_touch before update on public.betalinger
  for each row execute function public.touch_updated_at();


-- =========================================================
-- 7. VURDERINGER — anmeldelser av hjelpere
-- =========================================================
create table if not exists public.vurderinger (
  id           bigint generated always as identity primary key,
  oppdrag_id   bigint not null references public.oppdrag(id) on delete cascade,
  hjelper_id   uuid not null references public.profiler(id) on delete cascade,
  bruker_id    uuid not null references public.profiler(id) on delete cascade,
  stjerner     integer not null check (stjerner between 1 and 5),
  kommentar    text check (char_length(kommentar) <= 1000),
  created_at   timestamptz not null default now(),
  unique (oppdrag_id, hjelper_id)   -- én vurdering per fullført oppdrag
);

alter table public.vurderinger enable row level security;

drop policy if exists "vurderinger er offentlig lesbare" on public.vurderinger;
create policy "vurderinger er offentlig lesbare"
  on public.vurderinger for select
  using (true);

-- Bare oppdragets eier kan vurdere, og bare når oppdraget faktisk er merket
-- ferdig med akkurat den hjelperen - hindrer at noen dikter opp en vurdering
-- for et oppdrag de ikke eier eller en hjelper som aldri gjorde jobben.
drop policy if exists "eier kan vurdere hjelperen på et fullført oppdrag" on public.vurderinger;
create policy "eier kan vurdere hjelperen på et fullført oppdrag"
  on public.vurderinger for insert
  with check (
    bruker_id = auth.uid()
    and exists (
      select 1 from public.oppdrag o
      where o.id = oppdrag_id and o.bruker_id = auth.uid()
        and o.hjelper_id = vurderinger.hjelper_id and o.status = 'ferdig'
    )
  );

drop policy if exists "eier kan redigere egen vurdering" on public.vurderinger;
create policy "eier kan redigere egen vurdering"
  on public.vurderinger for update
  using (bruker_id = auth.uid())
  with check (bruker_id = auth.uid());

-- Holder profiler.rating i sync med snittet av vurderingene.
create or replace function public.oppdater_rating()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid := coalesce(new.hjelper_id, old.hjelper_id);
begin
  update public.profiler set rating = (
    select round(avg(stjerner)::numeric, 2) from public.vurderinger where hjelper_id = target
  ) where id = target;
  return null;
end;
$$;
drop trigger if exists vurdering_oppdater_rating on public.vurderinger;
create trigger vurdering_oppdater_rating
  after insert or update or delete on public.vurderinger
  for each row execute function public.oppdater_rating();

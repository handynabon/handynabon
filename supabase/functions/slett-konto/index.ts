// Sletter en brukers konto (auth.users-raden). Må kjøre som en Edge Function
// med service_role - vanlige klienter kan ikke slette sin egen auth-bruker
// med anon key alene, det finnes ingen slik RLS-vei i Supabase Auth.
//
// Kalles fra nobon.html via: sb.functions.invoke('slett-konto')
//
// profiler-raden slettes automatisk via "on delete cascade" fra auth.users
// (se supabase-schema.sql), som igjen sletter/nuller relaterte oppdrag,
// interesse og meldinger via de foreign key-reglene. Betalinger og
// vurderinger beholdes (historikk for den andre parten), men mister
// koblingen til en aktiv bruker siden profiler-raden er borte.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: userRes, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userRes.user) return json({ error: 'Ikke innlogget.' }, 401);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { error: delErr } = await admin.auth.admin.deleteUser(userRes.user.id);
    if (delErr) return json({ error: 'Klarte ikke å slette kontoen: ' + delErr.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

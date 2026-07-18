// Vipps ePayment - hent den AUTORITATIVE statusen på en betaling direkte fra
// Vipps sitt API. Kalles av nobon.html når brukeren kommer tilbake fra Vipps
// (via ?vipps_ref=... i URL-en).
//
// Viktig prinsipp (fra overleveringsnotatet): stol aldri på at nettleseren
// sier "betalt" - selv om brukeren havner tilbake på returnUrl, kan det
// forfalskes. Derfor sjekker denne funksjonen status hos Vipps selv, ikke
// bare hva klienten hevder. vipps-webhook (i tillegg) oppdaterer status
// uavhengig av om brukeren noensinne kommer tilbake til siden.
//
// IKKE TESTET mot et ekte Vipps-miljø - se advarselen i vipps-init/index.ts.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const required = ['VIPPS_CLIENT_ID', 'VIPPS_CLIENT_SECRET', 'VIPPS_SUBSCRIPTION_KEY',
      'VIPPS_MERCHANT_SERIAL_NUMBER', 'VIPPS_API_BASE'];
    for (const key of required) {
      if (!Deno.env.get(key)) return json({ error: `Vipps er ikke konfigurert (mangler ${key}).` }, 400);
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: userRes, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userRes.user) return json({ error: 'Ikke innlogget.' }, 401);

    const { reference } = await req.json();
    if (!reference) return json({ error: 'Mangler reference.' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: betaling } = await admin.from('betalinger').select('*').eq('vipps_referanse', reference).single();
    if (!betaling) return json({ error: 'Fant ingen betaling med den referansen.' }, 404);
    if (betaling.bruker_id !== userRes.user.id && betaling.hjelper_id !== userRes.user.id) {
      return json({ error: 'Dette er ikke din betaling.' }, 403);
    }

    const apiBase = Deno.env.get('VIPPS_API_BASE')!;
    const tokenRes = await fetch(`https://${apiBase}/accesstoken/get`, {
      method: 'POST',
      headers: {
        client_id: Deno.env.get('VIPPS_CLIENT_ID')!,
        client_secret: Deno.env.get('VIPPS_CLIENT_SECRET')!,
        'Ocp-Apim-Subscription-Key': Deno.env.get('VIPPS_SUBSCRIPTION_KEY')!,
      },
    });
    if (!tokenRes.ok) return json({ error: 'Klarte ikke å hente Vipps-token.' }, 502);
    const { access_token } = await tokenRes.json();

    const statusRes = await fetch(`https://${apiBase}/epayment/v1/payments/${reference}`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Ocp-Apim-Subscription-Key': Deno.env.get('VIPPS_SUBSCRIPTION_KEY')!,
        'Merchant-Serial-Number': Deno.env.get('VIPPS_MERCHANT_SERIAL_NUMBER')!,
      },
    });
    if (!statusRes.ok) return json({ error: 'Klarte ikke å hente status fra Vipps.' }, 502);
    const vippsData = await statusRes.json();

    var nyStatus = mapVippsState(vippsData.state);
    if (nyStatus !== betaling.status) {
      await admin.from('betalinger').update({ status: nyStatus }).eq('id', betaling.id);
      if (nyStatus === 'betalt') {
        await admin.from('oppdrag').update({ status: 'ferdig' }).eq('id', betaling.oppdrag_id);
      }
    }
    return json({ status: nyStatus });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function mapVippsState(state: string): string {
  if (state === 'AUTHORIZED' || state === 'CAPTURED') return 'betalt';
  if (state === 'TERMINATED' || state === 'EXPIRED') return 'kansellert';
  return 'opprettet';
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

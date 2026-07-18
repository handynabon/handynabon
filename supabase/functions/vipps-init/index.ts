// Vipps ePayment - start en betaling.
//
// Kalles fra klienten (nobon.html, "Betal med Vipps") via:
//   sb.functions.invoke('vipps-init', { body: { oppdragId, hjelperId } })
//
// Denne funksjonen kjører på Supabase sin server, ikke i nettleseren, så
// client_secret er trygg her - den må ALDRI havne i nobon.html.
//
// IKKE TESTET: jeg (Claude) har ikke et Vipps-testmiljø tilgjengelig, så dette
// er skrevet etter Vipps' offentlige ePayment API v1-dokumentasjon, men er
// ikke kjørt mot apitest.vipps.no. Dobbeltsjekk feltnavn/endepunkter mot
// https://developer.vipps.no/api/epayment/ før du går i produksjon, og test
// grundig i testmiljøet først.
//
// Miljøvariabler som må settes som Supabase secrets (se NOBON-SETUP.md):
//   VIPPS_CLIENT_ID, VIPPS_CLIENT_SECRET, VIPPS_SUBSCRIPTION_KEY,
//   VIPPS_MERCHANT_SERIAL_NUMBER, VIPPS_API_BASE (apitest.vipps.no i test,
//   api.vipps.no i produksjon), SITE_URL (for returnUrl),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (satt automatisk av Supabase)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const required = ['VIPPS_CLIENT_ID', 'VIPPS_CLIENT_SECRET', 'VIPPS_SUBSCRIPTION_KEY',
      'VIPPS_MERCHANT_SERIAL_NUMBER', 'VIPPS_API_BASE', 'SITE_URL'];
    for (const key of required) {
      if (!Deno.env.get(key)) {
        return json({ error: `Vipps er ikke konfigurert ennå (mangler secret: ${key}). Se NOBON-SETUP.md.` }, 400);
      }
    }

    // Verifiser at kalleren er en ekte innlogget bruker (sender med sin egen JWT).
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: userRes, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userRes.user) return json({ error: 'Ikke innlogget.' }, 401);
    const bruker = userRes.user;

    const { oppdragId } = await req.json();
    if (!oppdragId) return json({ error: 'Mangler oppdragId.' }, 400);

    // Bruk service_role for å hente oppdraget uavhengig av RLS-nyanser og for
    // å skrive til betalinger-tabellen (som vanlige brukere ikke kan skrive til).
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: oppdrag, error: oppdragErr } = await admin
      .from('oppdrag').select('*').eq('id', oppdragId).single();
    if (oppdragErr || !oppdrag) return json({ error: 'Fant ikke oppdraget.' }, 404);
    if (oppdrag.bruker_id !== bruker.id) return json({ error: 'Du eier ikke dette oppdraget.' }, 403);
    if (!oppdrag.hjelper_id) return json({ error: 'Oppdraget har ingen tildelt hjelper ennå.' }, 400);

    const belopKr = parseInt(String(oppdrag.pris ?? '').replace(/\D/g, ''), 10);
    if (!belopKr) return json({ error: 'Fant ingen pris å betale på oppdraget (fritekstpris kan ikke tolkes automatisk).' }, 400);
    const gebyrKr = Math.round(belopKr * 0.05);
    const belopOre = (belopKr + gebyrKr) * 100;

    const reference = crypto.randomUUID();
    const { data: betaling, error: betErr } = await admin.from('betalinger').insert({
      oppdrag_id: oppdrag.id,
      bruker_id: oppdrag.bruker_id,
      hjelper_id: oppdrag.hjelper_id,
      belop_ore: belopOre,
      vipps_referanse: reference,
      status: 'opprettet',
    }).select().single();
    if (betErr) return json({ error: 'Klarte ikke å opprette betalingsrad: ' + betErr.message }, 500);

    const apiBase = Deno.env.get('VIPPS_API_BASE')!;
    const tokenRes = await fetch(`https://${apiBase}/accesstoken/get`, {
      method: 'POST',
      headers: {
        client_id: Deno.env.get('VIPPS_CLIENT_ID')!,
        client_secret: Deno.env.get('VIPPS_CLIENT_SECRET')!,
        'Ocp-Apim-Subscription-Key': Deno.env.get('VIPPS_SUBSCRIPTION_KEY')!,
      },
    });
    if (!tokenRes.ok) {
      return json({ error: 'Klarte ikke å hente Vipps-token: ' + await tokenRes.text() }, 502);
    }
    const { access_token } = await tokenRes.json();

    const paymentRes = await fetch(`https://${apiBase}/epayment/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${access_token}`,
        'Ocp-Apim-Subscription-Key': Deno.env.get('VIPPS_SUBSCRIPTION_KEY')!,
        'Merchant-Serial-Number': Deno.env.get('VIPPS_MERCHANT_SERIAL_NUMBER')!,
        'Idempotency-Key': reference,
      },
      body: JSON.stringify({
        amount: { currency: 'NOK', value: belopOre },
        paymentMethod: { type: 'WALLET' },
        reference,
        returnUrl: `${Deno.env.get('SITE_URL')}/nobon.html?vipps_ref=${reference}`,
        userFlow: 'WEB_REDIRECT',
        paymentDescription: `Nobon-oppdrag #${oppdrag.id}: ${oppdrag.tittel}`,
      }),
    });
    if (!paymentRes.ok) {
      await admin.from('betalinger').update({ status: 'feilet' }).eq('id', betaling.id);
      return json({ error: 'Vipps avviste betalingen: ' + await paymentRes.text() }, 502);
    }
    const vippsData = await paymentRes.json();

    return json({ redirectUrl: vippsData.redirectUrl, reference });
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

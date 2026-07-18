// Vipps ePayment - webhook-mottaker.
//
// Registrer denne URL-en hos Vipps (Webhooks API, se
// https://developer.vipps.no/api/webhooks/) for hendelser som
// epayments.payment.authorized.v1 / .captured.v1 / .cancelled.v1 osv.
// Vipps gir deg en webhook-hemmelighet når du registrerer URL-en.
//
// VIKTIG, LES DETTE: Jeg (Claude) har ikke kunnet teste denne funksjonen mot
// et ekte Vipps-miljø, og Vipps sin nøyaktige signatur-signeringsmetode for
// webhook-kall er noe jeg ikke kan verifisere uten tilgang til dokumentasjonen
// og en sandkasse akkurat nå. Derfor er denne funksjonen bygget rundt et
// prinsipp som er trygt selv om signatursjekken under skulle vise seg å være
// feil: webhooket blir ALDRI stolt på direkte for å sette status="betalt".
// Det brukes kun som et signal om å slå opp den ekte, autoritative statusen
// hos Vipps sitt API (samme kall som vipps-status/index.ts gjør) og lagre DEN.
// Dette er tryggere enn å stole på hva som helst i webhook-bodyen.
//
// Før produksjon: verifiser signaturformatet mot Vipps' oppdaterte
// dokumentasjon og oppdater `verifiserSignatur` under - slik den står nå er
// den best-effort og logger et avvik i stedet for å blokkere, nettopp fordi
// den ikke er bekreftet riktig.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  try {
    const rawBody = await req.text();
    const signatureOk = await verifiserSignatur(req, rawBody);
    if (!signatureOk) {
      console.warn('Vipps-webhook: signatur kunne ikke bekreftes - fortsetter likevel, men slår opp ekte status hos Vipps før noe lagres. Se kommentaren øverst i fila.');
    }

    const event = JSON.parse(rawBody);
    const reference: string | undefined = event.reference;
    if (!reference) return new Response('mangler reference', { status: 400 });

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: betaling } = await admin.from('betalinger').select('*').eq('vipps_referanse', reference).single();
    if (!betaling) return new Response('ukjent referanse', { status: 404 });

    // Ikke stol på event.name/status fra webhook-bodyen alene - hent den ekte
    // statusen fra Vipps sitt API, samme kall som vipps-status/index.ts.
    const apiBase = Deno.env.get('VIPPS_API_BASE')!;
    const tokenRes = await fetch(`https://${apiBase}/accesstoken/get`, {
      method: 'POST',
      headers: {
        client_id: Deno.env.get('VIPPS_CLIENT_ID')!,
        client_secret: Deno.env.get('VIPPS_CLIENT_SECRET')!,
        'Ocp-Apim-Subscription-Key': Deno.env.get('VIPPS_SUBSCRIPTION_KEY')!,
      },
    });
    if (!tokenRes.ok) return new Response('klarte ikke å hente token', { status: 502 });
    const { access_token } = await tokenRes.json();

    const statusRes = await fetch(`https://${apiBase}/epayment/v1/payments/${reference}`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Ocp-Apim-Subscription-Key': Deno.env.get('VIPPS_SUBSCRIPTION_KEY')!,
        'Merchant-Serial-Number': Deno.env.get('VIPPS_MERCHANT_SERIAL_NUMBER')!,
      },
    });
    if (!statusRes.ok) return new Response('klarte ikke å hente status', { status: 502 });
    const vippsData = await statusRes.json();

    const nyStatus = vippsData.state === 'AUTHORIZED' || vippsData.state === 'CAPTURED' ? 'betalt'
      : vippsData.state === 'TERMINATED' || vippsData.state === 'EXPIRED' ? 'kansellert'
      : 'opprettet';

    if (nyStatus !== betaling.status) {
      await admin.from('betalinger').update({ status: nyStatus }).eq('id', betaling.id);
      if (nyStatus === 'betalt') {
        await admin.from('oppdrag').update({ status: 'ferdig' }).eq('id', betaling.oppdrag_id);
      }
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('Vipps-webhook feil:', e);
    return new Response('feil', { status: 500 });
  }
});

// Best-effort HMAC-SHA256-sjekk av Vipps sin webhook-signatur. IKKE bekreftet
// riktig format - se advarselen øverst i fila. Returnerer false uten å kaste
// hvis noe er feil, slik at hovedlogikken (som ikke stoler blindt på dette
// uansett) alltid kjører videre.
async function verifiserSignatur(req: Request, rawBody: string): Promise<boolean> {
  try {
    const secret = Deno.env.get('VIPPS_WEBHOOK_SECRET');
    const auth = req.headers.get('Authorization');
    if (!secret || !auth) return false;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    const sigHex = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
    return auth.includes(sigHex);
  } catch {
    return false;
  }
}

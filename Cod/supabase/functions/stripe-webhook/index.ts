import Stripe from 'npm:stripe@^14.0.0';
import { createClient } from 'npm:@supabase/supabase-js@^2.39.0';

// Inițializăm Stripe pentru mediul serverless
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const cryptoProvider = stripe.createCryptoProvider();

Deno.serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature');

  // Securitate: respingem orice request care nu vine de la Stripe
  if (!signature) {
    return new Response('Acces Interzis', { status: 400 });
  }

  const body = await req.text();
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  let event;

  try {
    if (!webhookSecret) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
    if (!signature) throw new Error("Missing Stripe-Signature header");

    // Validăm matematic semnătura
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret!,
      undefined,
      cryptoProvider
    );
  } catch (err: any) {
    console.error(`Eroare validare: ${err.message}`);
    return new Response(`Eroare Webhook`, { status: 400 });
  }

  // Interceptăm plata finalizată
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as any;
    const userId = session.client_reference_id; // ID-ul din Supabase trimis din Front-End

    if (userId) {
      // Inițializăm Supabase ca ADMIN pentru a putea scrie în baza de date
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      );

      // Actualizăm statusul în tabelul 'user_profiles' - sursa noastră de adevăr
      const { error } = await supabaseAdmin
        .from('user_profiles')
        .update({ is_paid: true, stripe_customer_id: session.customer })
        .eq('user_id', userId);

      if (error) {
        console.error('Eroare la update user:', error);
        return new Response('Eroare baza de date', { status: 500 });
      }
    }
  }

  // Răspuns de succes (200 OK) obligatoriu pentru Stripe
  return new Response(JSON.stringify({ status: 'succes' }), { 
    headers: { 'Content-Type': 'application/json' },
    status: 200 
  });
});
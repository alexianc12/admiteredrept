import Stripe from 'npm:stripe@^14.0.0';
import { createClient } from 'npm:@supabase/supabase-js@^2.39.0';

// Inițializăm Stripe pentru mediul serverless
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const cryptoProvider = stripe.createCryptoProvider();

// Adăugăm opțiunea { onListen: ... } pentru a dezactiva verificarea JWT.
// Securitatea este asigurată de validarea semnăturii Stripe de mai jos.
Deno.serve({ onListen: () => {} }, async (req) => {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Eroare validare webhook: ${msg}`);
    return new Response(`Eroare Webhook: Semnătură invalidă`, { status: 400 });
  }

  console.log(`[Webhook] Eveniment primit: ${event.type}`);

  // Interceptăm plata finalizată
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.client_reference_id; // ID-ul din Supabase trimis din Front-End
    const subscriptionId = session.subscription;

    if (userId && typeof subscriptionId === 'string') {
      console.log(`[Webhook] Procesare checkout.session.completed pentru user_id: ${userId}`);
      try {
        // Preluăm detaliile complete ale abonamentului de la Stripe
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        // Inițializăm Supabase ca ADMIN pentru a putea scrie în baza de date
        const supabaseAdmin = createClient(
          Deno.env.get('PROJECT_URL') ?? '',
          Deno.env.get('SERVICE_KEY') ?? ''
        );

        console.log(`[Webhook] Actualizare profil în Supabase...`);
        // Actualizăm statusul în tabelul 'user_profiles'
        const { error } = await supabaseAdmin
          .from('user_profiles')
          .update({ 
            is_paid: true, 
            stripe_customer_id: session.customer,
            stripe_subscription_id: subscription.id,
            subscription_status: 'active',
            subscription_current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
           })
          .eq('user_id', userId);

        if (error) {
          console.error('[Webhook] Eroare la update user în Supabase:', error);
          return new Response('Eroare baza de date', { status: 500 });
        }
        console.log(`[Webhook] Profilul pentru user_id: ${userId} a fost actualizat cu succes!`);
      } catch (stripeError) {
        console.error('[Webhook] Eroare la preluarea abonamentului de la Stripe:', stripeError);
        return new Response('Eroare server Stripe', { status: 500 });
      }
    }
  }

  // Interceptăm actualizarea abonamentului (ex: anularea reînnoirii)
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object as Stripe.Subscription;
    const supabaseAdmin = createClient(
        Deno.env.get('PROJECT_URL') ?? '', 
        Deno.env.get('SERVICE_KEY') ?? ''
    );

    // Dacă 'cancel_at_period_end' este true, înseamnă că utilizatorul a anulat reînnoirea.
    if (subscription.cancel_at_period_end) {
        console.log(`[Webhook] Anulare programată pentru subscription_id: ${subscription.id}`);
        await supabaseAdmin.from('user_profiles')
          .update({ 
            subscription_status: 'canceling', // Setăm un status nou pentru a ști că va expira
            subscription_current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          })
          .eq('stripe_subscription_id', subscription.id);
    } else {
        console.log(`[Webhook] Actualizare abonament (nu este anulare) pentru subscription_id: ${subscription.id}`);
        // Aici poți gestiona și alte actualizări, de exemplu, reactivarea unui abonament anulat.
        // Momentan, nu este necesar, dar e bine de știut.
    }
  }


  // Interceptăm anularea efectivă a abonamentului (la finalul perioadei)
  // Acest eveniment este trimis de Stripe automat când perioada plătită se încheie.
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription;
    const supabaseAdmin = createClient(
        Deno.env.get('PROJECT_URL') ?? '', 
        Deno.env.get('SERVICE_KEY') ?? ''
    );
    
    console.log(`[Webhook] Ștergere abonament (perioadă expirată) pentru subscription_id: ${subscription.id}`);
    // Căutăm user-ul după ID-ul de abonament și îi resetăm statusul
    await supabaseAdmin.from('user_profiles')
      .update({ is_paid: false, subscription_status: 'canceled', stripe_subscription_id: null, subscription_current_period_end: null })
      .eq('stripe_subscription_id', subscription.id);
  }

  // Răspuns de succes (200 OK) obligatoriu pentru Stripe
  return new Response(JSON.stringify({ status: 'succes' }), { 
    headers: { 'Content-Type': 'application/json' },
    status: 200 
  });
});
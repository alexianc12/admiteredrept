import { createClient } from 'npm:@supabase/supabase-js@^2.39.0';
import Stripe from 'npm:stripe@^14.0.0';

// Inițializăm Stripe pentru mediul serverless
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

// Adresa URL a aplicației tale
const APP_URL = Deno.env.get('APP_URL')!;

// Headerele CORS pe care le vom refolosi
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Răspunsul la "întrebarea de siguranță" a browserului (preflight request)
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders,
    });
  }

  const authHeader = req.headers.get('Authorization')!;
  if (!authHeader) {
    return new Response('Autentificare necesară', { status: 401 });
  }

  try {
    // Validăm utilizatorul cu Supabase folosind token-ul din frontend
    // Inițializăm clientul Supabase în contextul request-ului, folosind token-ul de autorizare al utilizatorului
    const supabaseClient = createClient(
      Deno.env.get('PROJECT_URL')!,
      Deno.env.get('PROJECT_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      console.error('Eroare autentificare:', userError?.message);
      return new Response('Utilizator invalid', { status: 401 });
    }

    // Creăm sesiunea de plată în Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: Deno.env.get('STRIPE_PRICE_ID')!, // ID-ul prețului din Stripe
          quantity: 1,
        },
      ],
      success_url: `${APP_URL}/profil?payment=success`,
      cancel_url: `${APP_URL}/profil?payment=canceled`,
      client_reference_id: user.id, // Trimitem ID-ul user-ului la Stripe
    });

    // Returnăm URL-ul de plată către frontend
    return new Response(
      JSON.stringify({ url: session.url }),
      {         
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('Eroare la crearea sesiunii de checkout:', error.message);
    return new Response(
      JSON.stringify({ error: `Eroare server: ${error.message}` }), 
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

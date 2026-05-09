import { Buffer } from 'buffer';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const sig = req.headers['stripe-signature'] as string;
  if (!sig) return res.status(400).send('Missing signature');

  const buf = await new Promise<Buffer>((resolve, reject) => {
    let data: any[] = [];
    req.on('data', (chunk: any) => data.push(chunk));
    req.on('end', () => resolve(Buffer.concat(data)));
    req.on('error', (err: any) => reject(err));
  });

  try {
    const event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET || '');

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as any;
      const userId = session.client_reference_id;

      if (userId) {
        console.log(`[Webhook] Activare premium pentru user_id: ${userId}`);
        const { error } = await supabaseAdmin
          .from('user_profiles')
          .update({ is_paid: true, stripe_customer_id: session.customer })
          .eq('user_id', userId);

        if (error) {
          console.error(`[Webhook] Eroare Supabase: ${error.message}`);
          throw error;
        }
        console.log(`[Webhook] Status updated cu succes pentru ${userId}`);
      }
    }
    res.json({ received: true });
  } catch (err: any) {
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
}
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { data } = await supabase
      .from('demo_stats')
      .select('*')
      .eq('date', new Date().toISOString().split('T')[0])
      .single();
    
    return res.json(data || {
      total_verifications: 0,
      successful_verifications: 0,
      total_cost_usd: 0
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

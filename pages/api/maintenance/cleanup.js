import { deleteOldSessionsAndImages } from '../../../lib/cleanup';

export default async function handler(req, res) {
  // CORS headers (optional for cron, but good practice)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Check for CRON_SECRET
  const token = req.query.token || req.headers['x-cron-secret'];
  const expectedSecret = process.env.CRON_SECRET;
  
  if (!expectedSecret) {
    console.warn('CRON_SECRET not configured - cleanup endpoint is unprotected!');
  } else if (token !== expectedSecret) {
    console.error('Invalid cron token received');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  console.log('Starting scheduled cleanup job...');
  
  try {
    const result = await deleteOldSessionsAndImages();
    
    if (result.success) {
      console.log(`Cleanup successful: ${result.deletedSessions} sessions, ${result.deletedImages} images`);
      return res.status(200).json(result);
    } else {
      console.error('Cleanup failed:', result.error);
      return res.status(500).json(result);
    }
  } catch (error) {
    console.error('Cleanup endpoint error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

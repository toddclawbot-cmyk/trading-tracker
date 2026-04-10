export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    const data = req.body;
    // Store the latest data
    // Using a global is ephemeral on Vercel, but for demo purposes we keep it
    // In production you'd use a KV store or database
    globalTradeData = data;
    return res.status(200).json({ success: true, received: true });
  }

  if (req.method === 'GET') {
    return res.status(200).json(globalTradeData || {
      balance: 10000,
      positions: [],
      trades: [],
      equityHistory: [],
      signals: [],
      lastUpdated: null
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

var globalTradeData = {
  balance: 10000,
  positions: [],
  trades: [],
  equityHistory: [{ time: new Date().toISOString(), equity: 10000 }],
  signals: [],
  lastUpdated: null
};

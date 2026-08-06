// api/save-push-subscription.js
// Reçoit l'abonnement PushSubscription créé côté client (index.html) et le stocke
// dans push_subscriptions pour que live-gate.js puisse envoyer les notifications.
const SUPABASE_URL = 'https://bddqezljktjzjfxgwvzk.supabase.co';

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const { subscription, userAgent } = req.body || {};
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      res.status(400).json({ error: 'subscription invalide' });
      return;
    }

    const row = {
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      user_agent: userAgent || null
    };

    const r = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row)
    });

    if (!r.ok) {
      const txt = await r.text();
      throw new Error('Supabase insert: HTTP ' + r.status + ' ' + txt.slice(0, 200));
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('save-push-subscription error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
};

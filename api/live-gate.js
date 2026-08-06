// api/live-gate.js
// Endpoint léger appelé en polling côté client (toutes les 1-2 min).
// N'interroge QUE Twelve Data (prix + EMA5/EMA8 + Stoch M15) — pas Gmail, pas Claude —
// pour rester quasi gratuit et rapide. Recalcule active_plan à partir des plans déjà
// stockés sur la dernière ligne cockpit_state, et fait un PATCH ciblé (pas un nouvel INSERT)
// pour ne pas faire grossir la table à chaque poll.
const { selectActivePlan } = require('../lib/active-plan-selector');
const webpush = require('web-push');

const SUPABASE_URL = 'https://bddqezljktjzjfxgwvzk.supabase.co';
const SYMBOL = 'XAU/USD';
const TD_BASE = 'https://api.twelvedata.com';

let vapidConfigured = false;
function ensureVapid() {
  if (vapidConfigured) return;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:contact@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    vapidConfigured = true;
  }
}

async function tdGet(path, params) {
  const url = new URL(TD_BASE + path);
  url.searchParams.set('apikey', process.env.TWELVEDATA_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.status === 'error') throw new Error('Twelve Data ' + path + ': ' + data.message);
  return data;
}

async function fetchGate() {
  const [price, ema5, ema8, stoch] = await Promise.all([
    tdGet('/price', { symbol: SYMBOL }),
    tdGet('/ema', { symbol: SYMBOL, interval: '15min', time_period: 5, outputsize: 1 }),
    tdGet('/ema', { symbol: SYMBOL, interval: '15min', time_period: 8, outputsize: 1 }),
    tdGet('/stoch', { symbol: SYMBOL, interval: '15min', fast_k_period: 5, slow_k_period: 3, slow_d_period: 3, outputsize: 1 })
  ]);
  return {
    price: parseFloat(price.price),
    ema5: parseFloat(ema5.values?.[0]?.ema),
    ema8: parseFloat(ema8.values?.[0]?.ema),
    stoch_k: parseFloat(stoch.values?.[0]?.slow_k),
    stoch_d: parseFloat(stoch.values?.[0]?.slow_d)
  };
}

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
  };
}

async function getLatestCockpitState() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/cockpit_state?select=id,plans,run_date&order=generated_at.desc&limit=1`,
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error('Lecture cockpit_state: HTTP ' + res.status);
  const data = await res.json();
  return data[0] || null;
}

async function patchActivePlan(id, activePlan) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cockpit_state?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ active_plan: activePlan })
  });
  if (!res.ok) throw new Error('Update active_plan: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

async function getPreviousActiveLetter() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/active_plan_log?select=active_letter&order=created_at.desc&limit=1`,
    { headers: sbHeaders() }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data[0] ? data[0].active_letter : null;
}

async function logActivePlanChange(entry) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/active_plan_log`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(entry)
  });
  if (!res.ok) console.error('active_plan_log insert a échoué:', res.status);
}

async function getPushSubscriptions() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth`,
    { headers: sbHeaders() }
  );
  if (!res.ok) return [];
  return res.json();
}

async function deletePushSubscription(id) {
  await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${id}`, {
    method: 'DELETE',
    headers: sbHeaders()
  }).catch(() => {});
}

async function notifyActivePlanChange(result, market) {
  ensureVapid();
  if (!vapidConfigured) return; // clés VAPID pas configurées sur Vercel, on saute silencieusement
  const subs = await getPushSubscriptions().catch(() => []);
  if (!subs.length) return;

  const title = result.letter ? `🎯 Plan ${result.letter} actif` : 'Plan actif : aucun';
  const body = result.reason
    ? `${result.reason} — XAU/USD ${market.price}`
    : `XAU/USD ${market.price}`;
  const payload = JSON.stringify({ title, body, tag: 'active-plan', url: '/' });

  await Promise.all(
    subs.map((s) =>
      webpush
        .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
        .catch((err) => {
          // 404/410 = abonnement expiré ou désinstallé côté navigateur -> on le retire
          if (err.statusCode === 404 || err.statusCode === 410) {
            return deletePushSubscription(s.id);
          }
          console.error('push send error:', err.statusCode || err.message);
        })
    )
  );
}

module.exports = async (req, res) => {
  try {
    const state = await getLatestCockpitState();
    if (!state) {
      res.status(200).json({ ok: true, active_plan: null });
      return;
    }

    const market = await fetchGate();
    const result = selectActivePlan(state.plans || {}, market);
    const activePlan = {
      letter: result.letter,
      reason: result.reason,
      since: new Date().toISOString(),
      price: market.price,
      misaligned: !!result.misaligned
    };

    await patchActivePlan(state.id, activePlan);

    const previousLetter = await getPreviousActiveLetter().catch(() => null);
    if (result.letter !== previousLetter) {
      await logActivePlanChange({
        plan_date: state.run_date,
        active_letter: result.letter,
        previous_letter: previousLetter,
        reason: result.reason,
        price: market.price,
        gate_verdict: market.ema5 > market.ema8 ? 'ACHAT' : 'VENTE',
        stoch_k: market.stoch_k,
        stoch_d: market.stoch_d,
        ema5: market.ema5,
        ema8: market.ema8
      }).catch(err => console.error('log active_plan_log a échoué:', err));

      if (result.letter) {
        await notifyActivePlanChange(result, market).catch(err => console.error('push notify a échoué:', err));
      }
    }

    res.status(200).json({ ok: true, active_plan: activePlan, market });
  } catch (err) {
    console.error('live-gate error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
};

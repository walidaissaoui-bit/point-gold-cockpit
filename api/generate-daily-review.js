// api/generate-daily-review.js
// Génère automatiquement la ligne `daily_reviews` du jour, en fin de session (cron ~22h UTC).
// Remplace le remplissage manuel abandonné depuis le 28/07 (voir diagnostic revue.html).
const SUPABASE_URL = 'https://bddqezljktjzjfxgwvzk.supabase.co';
const FALLBACK_REFRESH_SECRET = '39214b87c459b7946ad4b678e0b153ea1aeaea94ec86d78c';
const REFRESH_SECRET = process.env.REFRESH_SECRET || FALLBACK_REFRESH_SECRET;
const SYMBOL = 'XAU/USD';
const TD_BASE = 'https://api.twelvedata.com';

function isAuthorized(req) {
  if (req.headers['x-vercel-cron']) return true;
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const secret = url.searchParams.get('secret') || (req.body && req.body.secret);
  return secret === REFRESH_SECRET;
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

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
  };
}

async function fetchDayStats() {
  const [daily, atr] = await Promise.all([
    tdGet('/time_series', { symbol: SYMBOL, interval: '1day', outputsize: 1 }),
    tdGet('/atr', { symbol: SYMBOL, interval: '1day', time_period: 14, outputsize: 1 })
  ]);
  const bar = (daily.values || [])[0];
  if (!bar) throw new Error('Twelve Data: pas de bougie journalière disponible');
  const open = parseFloat(bar.open);
  const high = parseFloat(bar.high);
  const low = parseFloat(bar.low);
  const close = parseFloat(bar.close);
  const atr14 = parseFloat((atr.values || [])[0]?.atr ?? NaN);
  const range_total = high - low;
  const close_position = range_total > 0 ? (close - low) / range_total : 0.5;
  const atr_ratio = atr14 > 0 ? range_total / atr14 : null;
  return { open, high, low, close, range_total, close_position, atr_ratio, atr14 };
}

async function fetchReversalCount(tradingDate) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/active_plan_log?select=id&plan_date=eq.${tradingDate}`,
    { headers: sbHeaders() }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length;
}

async function fetchAnalystTally(tradingDate) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/analyst_calls?select=direction&trading_date=eq.${tradingDate}`,
    { headers: sbHeaders() }
  );
  if (!res.ok) return { buy: 0, sell: 0, neutral: 0 };
  const rows = await res.json();
  return rows.reduce((acc, r) => {
    acc[r.direction] = (acc[r.direction] || 0) + 1;
    return acc;
  }, { buy: 0, sell: 0, neutral: 0 });
}

// Prend les niveaux de la toute première génération du jour (le plan initial de la session,
// avant que les mises à jour intrajournalières ne les déplacent) et vérifie s'ils ont tenu
// face au high/low réel de la journée.
async function fetchMorningLevels(tradingDate) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/cockpit_state?select=levels&bot_id=eq.XAU&run_date=eq.${tradingDate}&status=eq.ok&order=generated_at.asc&limit=1`,
    { headers: sbHeaders() }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ? rows[0].levels : null;
}

function buildKeyLevelsRespected(morningLevels, stats) {
  if (!morningLevels) return null;
  const resistances = (morningLevels.resistances || []).map(r => ({
    price: r.price,
    desc: r.desc || '',
    respected: r.price == null ? null : stats.high <= r.price
  }));
  const supports = (morningLevels.supports || []).map(s => ({
    price: s.price,
    desc: s.desc || '',
    respected: s.price == null ? null : stats.low >= s.price
  }));
  return { resistances, supports };
}

async function classifyDay(stats, reversalCount, tally, keyLevels) {
  const system = `Tu es l'analyste du cockpit "Point Gold" (XAU/USD) de Walid. Tu classifies UNE journée
de trading déjà terminée. Réponds STRICTEMENT en JSON valide, sans texte avant/après, format exact :
{
  "day_type": "green_clear_bull|green_clear_bear|yellow_range|red_erratic|blue_false_start",
  "direction": "bullish|bearish|neutral",
  "summary": "string, 1-2 phrases résumant la journée pour la revue"
}
Guide de classification :
- green_clear_bull / green_clear_bear : tendance nette et propre dans un sens, peu de reversals.
- yellow_range : range/consolidation, pas de direction nette.
- red_erratic : beaucoup de reversals, journée chaotique, difficile à trader proprement.
- blue_false_start : démarrage dans un sens qui s'est inversé tôt et n'a jamais repris.`;

  const levelsLines = [];
  (keyLevels?.resistances || []).forEach(r => levelsLines.push(`Résistance ${r.price} (${r.desc || '—'}) : ${r.respected ? 'tenue' : 'cassée'}`));
  (keyLevels?.supports || []).forEach(s => levelsLines.push(`Support ${s.price} (${s.desc || '—'}) : ${s.respected ? 'tenu' : 'cassé'}`));

  const user = `STATS DU JOUR (XAU/USD)
Ouverture: ${stats.open}  Clôture: ${stats.close}
Haut: ${stats.high}  Bas: ${stats.low}
Range total: ${stats.range_total.toFixed(2)}  ATR14 (D1): ${isNaN(stats.atr14) ? '—' : stats.atr14.toFixed(2)}
Ratio range/ATR: ${stats.atr_ratio != null ? stats.atr_ratio.toFixed(2) : '—'}
Position de clôture dans le range (0=bas, 1=haut): ${stats.close_position.toFixed(2)}
Nombre de bascules de plan actif (gate M15) dans la journée: ${reversalCount ?? '—'}
Répartition des calls analystes du jour: ${tally.buy} achat / ${tally.sell} vente / ${tally.neutral} neutre
Niveaux clés du matin vs réalité :
${levelsLines.length ? levelsLines.join('\n') : '(aucun niveau clé enregistré ce jour-là)'}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) throw new Error('Anthropic API: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function upsertDailyReview(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/daily_reviews?on_conflict=trading_date`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error('Upsert daily_reviews: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
}

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const tradingDate = new Date().toISOString().split('T')[0];
    const stats = await fetchDayStats();
    const [reversalCount, tally, morningLevels] = await Promise.all([
      fetchReversalCount(tradingDate),
      fetchAnalystTally(tradingDate),
      fetchMorningLevels(tradingDate)
    ]);
    const keyLevels = buildKeyLevelsRespected(morningLevels, stats);
    const classification = await classifyDay(stats, reversalCount, tally, keyLevels);

    const row = {
      trading_date: tradingDate,
      day_type: classification.day_type,
      direction: classification.direction,
      open_price: stats.open,
      close_price: stats.close,
      high_price: stats.high,
      low_price: stats.low,
      range_total: stats.range_total,
      atr_ratio: stats.atr_ratio,
      close_position: stats.close_position,
      reversal_count: reversalCount,
      key_levels_respected: keyLevels,
      summary: classification.summary
    };

    await upsertDailyReview(row);
    res.status(200).json({ ok: true, trading_date: tradingDate, day_type: row.day_type });
  } catch (err) {
    console.error('generate-daily-review error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
};

// api/analyze-tradability.js
// Déclenché manuellement (bouton dans revue.html) pour une date donnée.
// Compare chaque call `analyst_calls` de ce jour au chemin de prix réel (Twelve Data, M15)
// pour déterminer si la zone d'entrée a été touchée, et si oui dans quel ordre SL/TP1/TP2
// ont été atteints. Écrit uniquement dans les colonnes `verdict_direction`/`score` de
// `analyst_calls` (déjà lues par les cartes "Verdicts analystes" et "Classement analystes"
// de revue.html) — ne touche pas à `analyst_scores_daily` (scoring Théo), volontairement
// gardé séparé (décision Walid du 07/08).
const SUPABASE_URL = 'https://bddqezljktjzjfxgwvzk.supabase.co';
const FALLBACK_REFRESH_SECRET = '39214b87c459b7946ad4b678e0b153ea1aeaea94ec86d78c';
const REFRESH_SECRET = process.env.REFRESH_SECRET || FALLBACK_REFRESH_SECRET;
const SYMBOL = 'XAU/USD';
const TD_BASE = 'https://api.twelvedata.com';

function isAuthorized(req) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const secret = url.searchParams.get('secret') || (req.body && req.body.secret);
  return secret === REFRESH_SECRET;
}

function sbHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
  };
}

async function fetchCalls(tradingDate) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/analyst_calls?select=id,analyst_name,direction,entry_zone_low,entry_zone_high,sl,tp1,tp2&trading_date=eq.${tradingDate}`,
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error('Fetch analyst_calls: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return res.json();
}

async function fetchDayCandles(tradingDate) {
  const url = new URL(TD_BASE + '/time_series');
  url.searchParams.set('apikey', process.env.TWELVEDATA_API_KEY);
  url.searchParams.set('symbol', SYMBOL);
  url.searchParams.set('interval', '15min');
  url.searchParams.set('start_date', `${tradingDate} 00:00:00`);
  url.searchParams.set('end_date', `${tradingDate} 23:59:59`);
  url.searchParams.set('outputsize', 100);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.status === 'error') throw new Error('Twelve Data /time_series: ' + data.message);
  const values = data.values || [];
  return values
    .map(v => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close)
    }))
    .sort((a, b) => a.time.localeCompare(b.time)); // Twelve Data renvoie desc -> on repasse en chronologique
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Détermine si la zone a été touchée puis, si oui, dans quel ordre SL/TP1/TP2 sont atteints
// en parcourant les bougies chronologiquement à partir du 1er contact avec la zone.
function evaluateCall(call, candles) {
  const { direction, entry_zone_low: lo, entry_zone_high: hi, sl, tp1, tp2 } = call;
  if (direction !== 'buy' && direction !== 'sell') {
    return { verdict_direction: 'n_a', score: null };
  }
  if (lo == null || hi == null) {
    return { verdict_direction: 'n_a', score: null };
  }
  const entry = (parseFloat(lo) + parseFloat(hi)) / 2;
  const zoneLow = Math.min(parseFloat(lo), parseFloat(hi));
  const zoneHigh = Math.max(parseFloat(lo), parseFloat(hi));

  const touchIndex = candles.findIndex(c => c.low <= zoneHigh && c.high >= zoneLow);
  if (touchIndex === -1) {
    return { verdict_direction: 'n_a', score: null }; // zone jamais atteinte ce jour-là
  }

  let tp1Hit = false;
  for (let i = touchIndex; i < candles.length; i++) {
    const c = candles[i];
    if (direction === 'buy') {
      const slHit = sl != null && c.low <= sl;
      const t2Hit = tp2 != null && c.high >= tp2;
      const t1Hit = tp1 != null && c.high >= tp1;
      if (slHit && !tp1Hit) return { verdict_direction: 'incorrect', score: round2(sl - entry) };
      if (t2Hit) return { verdict_direction: 'correct', score: round2(tp2 - entry) };
      if (t1Hit) tp1Hit = true;
    } else {
      const slHit = sl != null && c.high >= sl;
      const t2Hit = tp2 != null && c.low <= tp2;
      const t1Hit = tp1 != null && c.low <= tp1;
      if (slHit && !tp1Hit) return { verdict_direction: 'incorrect', score: round2(entry - sl) };
      if (t2Hit) return { verdict_direction: 'correct', score: round2(entry - tp2) };
      if (t1Hit) tp1Hit = true;
    }
  }
  // Fin de journée atteinte sans SL ni TP2
  const lastClose = candles[candles.length - 1].close;
  if (tp1Hit) {
    const score = direction === 'buy' ? round2(tp1 - entry) : round2(entry - tp1);
    return { verdict_direction: 'correct', score };
  }
  const score = direction === 'buy' ? round2(lastClose - entry) : round2(entry - lastClose);
  return { verdict_direction: 'pending', score };
}

async function patchCall(id, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/analyst_calls?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error(`Patch analyst_calls#${id}: HTTP ` + res.status + ' ' + (await res.text()).slice(0, 300));
}

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const tradingDate = url.searchParams.get('date');
  if (!tradingDate || !/^\d{4}-\d{2}-\d{2}$/.test(tradingDate)) {
    res.status(400).json({ error: 'paramètre date=YYYY-MM-DD requis' });
    return;
  }
  try {
    const calls = await fetchCalls(tradingDate);
    if (!calls.length) {
      res.status(200).json({ ok: true, date: tradingDate, updated: 0, results: [] });
      return;
    }
    const candles = await fetchDayCandles(tradingDate);
    const results = [];
    for (const call of calls) {
      const outcome = evaluateCall(call, candles);
      await patchCall(call.id, outcome);
      results.push({ id: call.id, analyst_name: call.analyst_name, direction: call.direction, ...outcome });
    }
    res.status(200).json({ ok: true, date: tradingDate, candles: candles.length, updated: results.length, results });
  } catch (err) {
    console.error('analyze-tradability error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
};

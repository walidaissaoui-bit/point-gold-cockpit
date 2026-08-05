// api/refresh-cockpit.js
// Pipeline Point Gold : Gmail (TradingView) + Twelve Data (prix/indicateurs) + Claude (synthèse)
// -> écrit une ligne dans Supabase `cockpit_state`.
const { selectActivePlan } = require('../lib/active-plan-selector');

const SUPABASE_URL = 'https://bddqezljktjzjfxgwvzk.supabase.co';
const FALLBACK_REFRESH_SECRET = '39214b87c459b7946ad4b678e0b153ea1aeaea94ec86d78c';
const REFRESH_SECRET = process.env.REFRESH_SECRET || FALLBACK_REFRESH_SECRET;

const SYMBOL = 'XAU/USD';
const BOT_ID = 'XAU';

const ANALYSTS = [
  'Jun_DailyForex', 'Richard_PrimeInsights', 'Jameshead007', 'Riley-Gold',
  'XAUUSD_Vision', 'Zamagor', 'Elina-Xau', 'GoldTrend_Master', 'Franck_Trader',
  'Fiora_Wintrade', 'GOLD_SUPPLIER', 'Huntmoney_trading', 'WavePoint_FX',
  'Mian-FXSignals', 'Olinvest', 'Blake_gold', 'CaptionGold_Trader',
  'nsts2046', 'Jennifer_FanGolden'
];

function isAuthorized(req) {
  if (req.headers['x-vercel-cron']) return true;
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const secret = url.searchParams.get('secret') || (req.body && req.body.secret);
  return secret === REFRESH_SECRET;
}

async function gmailAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) throw new Error('Gmail OAuth refresh a échoué: HTTP ' + res.status);
  const data = await res.json();
  return data.access_token;
}

function decodeBase64Url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data && !payload.parts) {
    const html = decodeBase64Url(payload.body.data);
    return html.replace(/<style[\s\S]*?<\/style>/gi, ' ')
               .replace(/<[^>]+>/g, ' ')
               .replace(/\s+/g, ' ')
               .trim();
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = extractPlainText(p);
      if (t) return t;
    }
  }
  return '';
}

async function fetchAnalystEmails() {
  const token = await gmailAccessToken();
  const headers = { Authorization: `Bearer ${token}` };

  const q = encodeURIComponent('from:noreply@tradingview.com newer_than:2d');
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=50`,
    { headers }
  );
  if (!listRes.ok) throw new Error('Gmail list a échoué: HTTP ' + listRes.status);
  const listData = await listRes.json();
  const ids = (listData.messages || []).map(m => m.id);

  const emails = [];
  for (const id of ids) {
    const mRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers }
    );
    if (!mRes.ok) continue;
    const msg = await mRes.json();
    const hdrs = (msg.payload && msg.payload.headers) || [];
    const subject = (hdrs.find(h => h.name === 'Subject') || {}).value || '';
    const from = (hdrs.find(h => h.name === 'From') || {}).value || '';
    const dateHdr = (hdrs.find(h => h.name === 'Date') || {}).value || '';
    const body = extractPlainText(msg.payload).slice(0, 4000);

    const analyst = ANALYSTS.find(a => subject.includes(a) || body.includes(a) || from.includes(a));
    emails.push({ id, subject, from, date: dateHdr, analyst: analyst || null, body });
  }
  emails.sort((a, b) => (b.analyst ? 1 : 0) - (a.analyst ? 1 : 0));
  return emails;
}

const TD_BASE = 'https://api.twelvedata.com';

async function tdGet(path, params) {
  const url = new URL(TD_BASE + path);
  url.searchParams.set('apikey', process.env.TWELVEDATA_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.status === 'error') throw new Error('Twelve Data ' + path + ': ' + data.message);
  return data;
}

async function fetchMarketData() {
  const [quote, price, m15, m5, ema5, ema8, stoch] = await Promise.all([
    tdGet('/quote', { symbol: SYMBOL }),
    tdGet('/price', { symbol: SYMBOL }),
    tdGet('/time_series', { symbol: SYMBOL, interval: '15min', outputsize: 60 }),
    tdGet('/time_series', { symbol: SYMBOL, interval: '5min', outputsize: 50 }),
    tdGet('/ema', { symbol: SYMBOL, interval: '15min', time_period: 5, outputsize: 60 }),
    tdGet('/ema', { symbol: SYMBOL, interval: '15min', time_period: 8, outputsize: 60 }),
    tdGet('/stoch', { symbol: SYMBOL, interval: '15min', fast_k_period: 5, slow_k_period: 3, slow_d_period: 3, outputsize: 60 })
  ]);

  const m15Values = (m15.values || []).slice().reverse();
  const m5Values = (m5.values || []).slice().reverse();
  const emaMap = (arr) => Object.fromEntries((arr.values || []).map(v => [v.datetime, parseFloat(v.ema)]));
  const ema5Map = emaMap(ema5);
  const ema8Map = emaMap(ema8);
  const stochMap = Object.fromEntries((stoch.values || []).map(v => [v.datetime, { k: parseFloat(v.slow_k), d: parseFloat(v.slow_d) }]));

  const labels = m15Values.map(v => v.datetime);
  const priceArr = m15Values.map(v => parseFloat(v.close));
  const ema5Arr = labels.map(t => ema5Map[t] ?? null);
  const ema8Arr = labels.map(t => ema8Map[t] ?? null);
  const stochKArr = labels.map(t => (stochMap[t] ? stochMap[t].k : null));
  const stochDArr = labels.map(t => (stochMap[t] ? stochMap[t].d : null));

  const candles = m5Values
    .filter(v => v.datetime && v.open)
    .map(v => ({
      time: Math.floor(new Date(v.datetime + 'Z').getTime() / 1000),
      open: parseFloat(v.open), high: parseFloat(v.high),
      low: parseFloat(v.low), close: parseFloat(v.close)
    }));

  const dayHigh = Math.max(...m15Values.map(v => parseFloat(v.high)));
  const dayLow = Math.min(...m15Values.map(v => parseFloat(v.low)));
  const dayOpen = m15Values.length ? parseFloat(m15Values[0].open) : null;

  const lastK = stochKArr.filter(v => v != null).pop() ?? null;
  const lastD = stochDArr.filter(v => v != null).pop() ?? null;
  const lastEma5 = ema5Arr.filter(v => v != null).pop() ?? null;
  const lastEma8 = ema8Arr.filter(v => v != null).pop() ?? null;

  return {
    price: parseFloat(price.price),
    prev_close: parseFloat(quote.previous_close),
    change: parseFloat(quote.change),
    change_pct: parseFloat(quote.percent_change),
    day_open: dayOpen, day_high: dayHigh, day_low: dayLow,
    stoch_k: lastK, stoch_d: lastD, ema5: lastEma5, ema8: lastEma8,
    chart: { labels, price: priceArr, ema5: ema5Arr, ema8: ema8Arr, stoch_k: stochKArr, stoch_d: stochDArr, candles }
  };
}

async function synthesize(emails, market) {
  const emailsBlock = emails.slice(0, 20).map(e =>
    `--- ${e.analyst || e.from} (${e.date}) ---\n${e.subject}\n${e.body}`
  ).join('\n\n');

  const system = `Tu es l'analyste du cockpit de trading "Point Gold" (XAU/USD) de Walid.
Méthode v3.x : la porte d'entrée (gate) est purement technique — Stoch(5,3,3) et EMA5/EMA8
sur bougies M15 CLÔTURÉES, confirmation de structure BOS/CHoCH. AUCUNE fenêtre horaire :
ne jamais suggérer d'attendre une heure précise, le setup prime.
Tu dois répondre STRICTEMENT en JSON valide, sans texte avant/après, sans balises markdown,
au format exact suivant :
{
  "gate_verdict": "string court (ex: ACHAT / VENTE / NO-TRADE / ATTENTE)",
  "gate_detail": "string, 1-2 phrases expliquant le verdict",
  "levels": {
    "resistances": [{"price": number, "desc": "string"}],
    "supports": [{"price": number, "desc": "string"}]
  },
  "analyst_synthesis": {
    "bear": [{"who": "nom analyste", "note": "résumé court de sa thèse"}],
    "bull": [{"who": "nom analyste", "note": "résumé court de sa thèse"}],
    "summary": "string, synthèse nette 1-2 phrases"
  },
  "plans": {
    "A": {"dir": "buy|sell", "role": "string", "zone": [low, high], "trigger": "string", "targets": [n, n], "invalid": number, "reversal": boolean},
    "B": {...}, "C": {...}, "D": {...}
  },
  "discipline": "string, rappels de discipline pertinents pour la session (1-3 phrases)"
}
Pour chaque plan, "reversal" doit valoir true si le plan parie sur un retournement/rejet contre la
tendance en cours (mean-reversion, résistance/support attendu à tenir), et false si le plan suit la
tendance en cours ou une continuation/breakout. NE PAS te baser sur la lettre du plan (A/B/C/D) —
cela dépend uniquement de la logique de marché décrite ce jour-là ; un plan A peut très bien être le
reversal un jour donné et B la continuation un autre jour.
Base les niveaux clés et les plans A/B/C/D sur la synthèse des emails d'analystes ET sur les
données de marché fournies (prix, range, EMA, Stoch). Si une info manque, fais une estimation
raisonnable plutôt que de casser le JSON.`;

  const user = `DONNÉES MARCHÉ ACTUELLES (XAU/USD)
Prix: ${market.price}  |  Veille: ${market.prev_close}  |  Var: ${market.change} (${market.change_pct}%)
Range du jour: ${market.day_low} -> ${market.day_high} (ouverture ${market.day_open})
Stoch(5,3,3) M15: %K=${market.stoch_k} %D=${market.stoch_d}
EMA5/EMA8 M15: ${market.ema5} / ${market.ema8}

EMAILS ANALYSTES (dernières 48h) :
${emailsBlock || '(aucun email pertinent trouvé dans les dernières 48h)'}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
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

async function getPreviousActiveLetter() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/active_plan_log?select=active_letter&order=created_at.desc&limit=1`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data[0] ? data[0].active_letter : null;
}

async function logActivePlanChange(entry) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/active_plan_log`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(entry)
  });
  if (!res.ok) console.error('active_plan_log insert a échoué:', res.status, (await res.text()).slice(0, 300));
}

async function writeCockpitState(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cockpit_state`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error('Supabase insert cockpit_state: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
}

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const [emails, market] = await Promise.all([
      fetchAnalystEmails().catch(err => { console.error('Gmail:', err.message); return []; }),
      fetchMarketData()
    ]);

    const synth = await synthesize(emails, market);

    const activePlan = selectActivePlan(synth.plans || {}, {
      price: market.price, ema5: market.ema5, ema8: market.ema8
    });
    const generatedAt = new Date().toISOString();

    const row = {
      bot_id: BOT_ID,
      run_date: generatedAt.split('T')[0],
      generated_at: generatedAt,
      price: market.price,
      prev_close: market.prev_close,
      change: market.change,
      change_pct: market.change_pct,
      day_open: market.day_open,
      day_high: market.day_high,
      day_low: market.day_low,
      gate_verdict: synth.gate_verdict,
      gate_detail: synth.gate_detail,
      stoch_k: market.stoch_k,
      stoch_d: market.stoch_d,
      ema5: market.ema5,
      ema8: market.ema8,
      levels: synth.levels,
      analyst_synthesis: synth.analyst_synthesis,
      plans: synth.plans,
      discipline: synth.discipline,
      status: 'ok',
      error: null,
      chart: market.chart,
      active_plan: {
        letter: activePlan.letter,
        reason: activePlan.reason,
        since: generatedAt,
        price: market.price,
        misaligned: !!activePlan.misaligned
      }
    };

    await writeCockpitState(row);

    const previousLetter = await getPreviousActiveLetter().catch(() => null);
    if (activePlan.letter !== previousLetter) {
      await logActivePlanChange({
        plan_date: row.run_date,
        active_letter: activePlan.letter,
        previous_letter: previousLetter,
        reason: activePlan.reason,
        price: market.price,
        gate_verdict: synth.gate_verdict,
        stoch_k: market.stoch_k,
        stoch_d: market.stoch_d,
        ema5: market.ema5,
        ema8: market.ema8
      }).catch(err => console.error('Log active_plan_log a échoué:', err));
    }

    res.status(200).json({ ok: true, generated_at: row.generated_at, active_plan: activePlan.letter });
  } catch (err) {
    console.error('refresh-cockpit error:', err);
    try {
      await writeCockpitState({
        bot_id: BOT_ID,
        run_date: new Date().toISOString().split('T')[0],
        generated_at: new Date().toISOString(),
        status: 'error',
        error: String(err.message || err)
      });
    } catch (e2) {
      console.error('Impossible d\'écrire la ligne d\'erreur:', e2);
    }
    res.status(500).json({ error: String(err.message || err) });
  }
};

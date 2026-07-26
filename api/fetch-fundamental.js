// api/fetch-fundamental.js
// Pipeline Point Gold — volet FONDAMENTAL (indépendant du pipeline analystes/Twelve Data
// existant dans api/refresh-cockpit.js — ce fichier ne le modifie pas et n'en dépend pas).
//
// Enchaîne : calendrier macro (flux public gratuit) + Alpha Vantage (news sentiment) → synthèse Claude
// → écrit une ligne dans Supabase `fundamental_state`.
//
// Variables d'environnement requises (Vercel > Settings > Environment Variables) :
//   ALPHAVANTAGE_API_KEY        - clé API Alpha Vantage (gratuite)
// (calendrier macro : flux public gratuit ForexFactory, aucune clé requise)
//   ANTHROPIC_API_KEY           - déjà présente (réutilisée)
//   SUPABASE_URL                - déjà présente (réutilisée)
//   SUPABASE_SERVICE_ROLE_KEY   - déjà présente (réutilisée)
//   REFRESH_SECRET / CRON_SECRET - même secret que le refresh existant (fallback ci-dessous)

const SUPABASE_URL = 'https://bddqezljktjzjfxgwvzk.supabase.co';
const FALLBACK_SECRET = '39214b87c459b7946ad4b678e0b153ea1aeaea94ec86d78c';
const SECRET = process.env.REFRESH_SECRET || FALLBACK_SECRET;
const BOT_ID = 'XAU';

function isAuthorized(req) {
  if (req.headers['x-vercel-cron']) return true; // invocation cron Vercel (trustée)
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const secret = url.searchParams.get('secret') || (req.body && req.body.secret);
  return secret === SECRET;
}

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

// ---------- Calendrier macro ----------
// Flux public gratuit, sans clé API (largement utilisé par les EA MQL5 pour le même usage).
// Couvre la semaine en cours ; on filtre ensuite sur la fenêtre utile (aujourd'hui -> +3 jours).
async function fetchMacroCalendar() {
  const url = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
  const data = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.json());
  if (!Array.isArray(data)) return [];

  const RELEVANT = ['USD', 'EUR', 'CNY', 'GBP'];
  const now = Date.now();
  const windowEnd = now + 4 * 24 * 60 * 60 * 1000; // +4 jours de marge

  return data
    .filter((e) => RELEVANT.includes(e.country))
    .filter((e) => e.impact === 'High' || e.impact === 'Medium')
    .filter((e) => {
      const t = new Date(e.date).getTime();
      return !isNaN(t) && t >= now - 24 * 60 * 60 * 1000 && t <= windowEnd;
    })
    .slice(0, 25)
    .map((e) => ({
      date: e.date,
      currency: e.country,
      event: e.title,
      impact: e.impact,
      actual: e.actual,
      previous: e.previous,
      estimate: e.forecast,
    }));
}

// ---------- Alpha Vantage : news sentiment ----------
async function fetchNewsSentiment() {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=economy_macro,economy_monetary,financial_markets&limit=25&apikey=${key}`;
  const data = await fetch(url).then((r) => r.json());
  const feed = Array.isArray(data.feed) ? data.feed : [];

  return feed.slice(0, 20).map((a) => ({
    title: a.title,
    time_published: a.time_published,
    source: a.source,
    overall_sentiment_label: a.overall_sentiment_label,
    overall_sentiment_score: a.overall_sentiment_score,
    summary: (a.summary || '').slice(0, 280),
  }));
}

// ---------- Claude : synthèse fondamentale ----------
async function synthesize(calendar, news) {
  const system = `Tu es l'assistant Point Gold de Walid (XAU/USD, méthode v3.x). Tu analyses UNIQUEMENT le volet fondamental (macro + news), pas la technique. Ton rôle : dire si un événement macro à venir dans les prochaines 24-48h doit faire élargir les zones d'invalidation des plans A/B/C/D ou inciter à la prudence, PAS proposer de nouveau signal directionnel autonome. Réponds UNIQUEMENT en JSON valide, sans texte avant/après, sans balises markdown.`;

  const user = `CALENDRIER MACRO (USD/EUR/CNY/GBP, impact fort ou mots-clés majeurs) :
${JSON.stringify(calendar, null, 2)}

NEWS SENTIMENT (macro / marchés financiers, dernières news) :
${JSON.stringify(news, null, 2)}

Réponds avec exactement ces champs :
{
  "bias": "haussier" | "baissier" | "neutre",
  "upcoming_events": [ { "date": string, "event": string, "why_it_matters": string } ],
  "sentiment_summary": string,
  "risk_note": string,
  "summary": string
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error('Anthropic API: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('');
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ---------- Supabase ----------
async function writeFundamentalState(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/fundamental_state`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error('Supabase insert fundamental_state: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
}

// ---------- Handler ----------
module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const [calendar, news] = await Promise.all([
      fetchMacroCalendar().catch((err) => { console.error('Calendar:', err.message); return []; }),
      fetchNewsSentiment().catch((err) => { console.error('AlphaVantage:', err.message); return []; }),
    ]);

    const synth = await synthesize(calendar, news);

    await writeFundamentalState({
      bot_id: BOT_ID,
      run_date: todayISO(),
      generated_at: new Date().toISOString(),
      status: 'ok',
      calendar_events: calendar,
      news_sentiment: news,
      fundamental_summary: synth,
    });

    res.status(200).json({ ok: true, events: calendar.length, news: news.length });
  } catch (e) {
    await writeFundamentalState({
      bot_id: BOT_ID,
      run_date: todayISO(),
      generated_at: new Date().toISOString(),
      status: 'error',
      error: String(e && e.message ? e.message : e),
    }).catch(() => {});
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
};

// lib/active-plan-selector.js
// Détermine quel plan (A/B/C/D) est prioritaire à un instant donné.
//
// Règle : un plan est "à portée" si le prix est dans sa zone ou à une distance
// <= la moitié de la largeur de zone (min 5$). Si un seul plan est à portée,
// il est actif. Si plusieurs se chevauchent, le gate M15 (EMA5 vs EMA8) tranche
// en faveur du/des plan(s) dont la direction correspond ; en cas d'égalité de
// direction, le plus proche du prix gagne. Si aucun plan à portée ne correspond
// au gate, on retient quand même le plus proche mais on le marque `misaligned`.

function selectActivePlan(plans, market) {
  const price = market.price;
  const gateDir = (market.ema5 > market.ema8) ? 'buy' : 'sell';
  const letters = ['A', 'B', 'C', 'D'];
  const inPlay = [];

  for (const letter of letters) {
    const p = plans && plans[letter];
    if (!p || p.enabled === false || !Array.isArray(p.zone) || p.zone.length < 2) continue;
    const [a, b] = p.zone;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const distance = price < low ? low - price : price > high ? price - high : 0;
    const proximity = Math.max((high - low) * 0.5, 5);
    if (distance <= proximity) {
      inPlay.push({ letter, ...p, zoneLow: low, zoneHigh: high, distance });
    }
  }

  if (inPlay.length === 0) {
    return { letter: null, reason: `Aucun plan à portée du prix actuel (${price})`, reasonType: 'none' };
  }

  if (inPlay.length === 1) {
    const only = inPlay[0];
    return {
      letter: only.letter,
      reason: `Seul plan à portée (zone ${only.zoneLow}-${only.zoneHigh})`,
      reasonType: 'single'
    };
  }

  const overlapLetters = inPlay.map((p) => p.letter).join('/');
  const matching = inPlay.filter((p) => p.dir === gateDir);

  if (matching.length >= 1) {
    matching.sort((a, b) => a.distance - b.distance);
    const winner = matching[0];
    const gateLabel = gateDir === 'buy' ? 'haussier' : 'baissier';
    return {
      letter: winner.letter,
      reason: `Chevauchement (${overlapLetters}) résolu par le gate M15 ${gateLabel} ` +
        `(EMA5 ${market.ema5} ${gateDir === 'buy' ? '>' : '<'} EMA8 ${market.ema8})` +
        (matching.length > 1 ? ' — plusieurs plans alignés, le plus proche du prix retenu' : ''),
      reasonType: 'gate'
    };
  }

  inPlay.sort((a, b) => a.distance - b.distance);
  const fallback = inPlay[0];
  const gateLabel = gateDir === 'buy' ? 'haussier' : 'baissier';
  return {
    letter: fallback.letter,
    reason: `Chevauchement (${overlapLetters}) mais gate ${gateLabel} désaligné avec tous les plans ` +
      `à portée — ${fallback.letter} retenu par proximité, à confirmer avant toute entrée`,
    reasonType: 'fallback',
    misaligned: true
  };
}

module.exports = { selectActivePlan };

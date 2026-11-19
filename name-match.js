'use strict';

// Compare a person's name between Morningstar and ZiiroPay without being fooled by accents, hyphens, case,
// swapped order or an extra middle name. Both names are reduced to letter-only words; every word of the shorter
// name must appear in the longer one, and a name with several words must share at least two.
const words = (...parts) => parts.join(' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
function sameName(firstA, lastA, firstB, lastB) {
  const a = new Set(words(firstA, lastA)), b = new Set(words(firstB, lastB));
  if (!a.size || !b.size) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (![...small].every((w) => big.has(w))) return false;
  return small.size >= 2 || big.size === small.size;
}
module.exports = { sameName };

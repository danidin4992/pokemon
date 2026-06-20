import { matchesListing, containsKeyword } from '../src/filters.js';

const settings = {
  global_required_keywords: ['PSA', 'CGC', 'BGS'],
  global_forbidden_keywords: ['9'],
};
const search = {
  required_keywords: null,
  forbidden_keywords: null,
};

const cases = [
  ['PSA 10 Charizard Base Set', true],
  ['PSA 9 Charizard', false], // forbidden "9"
  ['psa 10 pikachu', true], // case-insensitive
  ['CGC 10 Mew', true],
  ['Pokemon 1995 card', false], // no required
  ['Pokemon 1995 PSA 10', true], // "1995" doesn't contain "9" as word
  ['BGS 9.5 Dragonite', false], // "9" as part of "9.5" — matches!
  ['BGS 8.5 Dragonite', true], // 8.5 ok
  ['PSA9 Charizard', false], // "9" as standalone? PSA9 is a single token — "9" at end matches via boundary
];

console.log('--- filter test ---');
for (const [title, expected] of cases) {
  const got = matchesListing(title, search, settings);
  const mark = got === expected ? '✓' : '✗';
  console.log(`${mark} "${title}" → ${got} (expected ${expected})`);
}

console.log('\n--- per-search keywords (require "Charizard") ---');
const search2 = { required_keywords: ['Charizard'], forbidden_keywords: null };
for (const [title, expected] of [
  ['PSA 10 Charizard Base Set', true],
  ['PSA 10 Pikachu Promo', false],
  ['CGC 10 Charizard VMax', true],
]) {
  const got = matchesListing(title, search2, settings);
  const mark = got === expected ? '✓' : '✗';
  console.log(`${mark} "${title}" → ${got} (expected ${expected})`);
}

import fs from 'fs';
import { parseListings } from '../src/scraper.js';

const html = fs.readFileSync('/tmp/ebay-test2.html', 'utf8');
const listings = parseListings(html);

console.log(`Parsed ${listings.length} listings\n`);
console.log('--- First 3 ---');
listings.slice(0, 3).forEach((l, i) => {
  console.log(`\n[${i}]`, JSON.stringify(l, null, 2));
});

const withEnd = listings.filter((l) => l.ends_at);
const ending24h = withEnd.filter((l) => l.ends_at - Math.floor(Date.now() / 1000) <= 86400);
console.log(`\nWith ends_at: ${withEnd.length}`);
console.log(`Ending within 24h: ${ending24h.length}`);
console.log(`Ending soon flag: ${listings.filter((l) => l.ending_soon).length}`);

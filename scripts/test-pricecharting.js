import { fetchProductInfo } from '../src/pricecharting.js';

const url = process.argv[2] || 'https://www.pricecharting.com/game/pokemon-ascended-heroes/pikachu-ex-276';
const info = await fetchProductInfo(url);
console.log(JSON.stringify(info, null, 2));

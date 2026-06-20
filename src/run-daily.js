import 'dotenv/config';
import { runAllSearches } from './runner.js';
import { sendDigest } from './emailer.js';

const skipEmail = process.argv.includes('--no-email');
const startedAt = new Date();

console.log(`[${startedAt.toISOString()}] Starting daily run`);

try {
  const result = await runAllSearches({
    onProgress: (e) => {
      if (e.stage === 'scraping') console.log(`  scraping: ${e.search.name}`);
      if (e.stage === 'scraped') console.log(`    → ${e.found} listings (${e.isNew} new)`);
      if (e.stage === 'error') console.error(`    ✗ ${e.error}`);
    },
  });

  console.log(`\nTotal: ${result.totalFound} listings, ${result.totalNew} new`);

  let emailSent = false;
  if (!skipEmail) {
    try {
      console.log('Sending digest email...');
      await sendDigest();
      emailSent = true;
      console.log('  ✓ Email sent');
    } catch (e) {
      console.error('  ✗ Email failed:', e.message);
    }
  } else {
    console.log('Skipping email (--no-email)');
  }

  result.finish({ emailSent });
  console.log(`[${new Date().toISOString()}] Done`);
  process.exit(0);
} catch (err) {
  console.error('Run failed:', err);
  process.exit(1);
}

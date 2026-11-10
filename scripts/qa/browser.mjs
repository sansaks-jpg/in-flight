// Starts ONE long-lived headless Chromium (CDP on :9222), opens the game, starts a flight and waits for the flight deck.
// Other QA scripts attach with connect() so the 60 s deck load happens only once.
import { launch, startFlight } from './lib.mjs';
const { page, errors } = await launch({ width: 960, height: 540 });
await startFlight(page);
console.log('READY'); 
setInterval(() => { if (errors.length > 50) errors.length = 0; }, 10000);

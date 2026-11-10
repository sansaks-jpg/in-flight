import { chromium } from 'playwright';
export async function connect(port = 9222) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  return { browser, page };
}

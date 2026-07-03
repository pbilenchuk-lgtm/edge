import { chromium } from "playwright-core";

const EXEC = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = process.env.SHOT_BASE || "http://127.0.0.1:3120";
const OUT = process.env.SHOT_OUT || ".";

const screens = [
  ["Матчи", "matches"],
  ["Портфель", "portfolio"],
  ["Метрики", "metrics"],
  ["Стратегии", "strategies"],
  ["Лента", "feed"],
  ["Модели", "models"],
];

const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1180, height: 1400 }, deviceScaleFactor: 2 });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

for (const [label, slug] of screens) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await page.waitForTimeout(450);
  const file = `${OUT}/screen-${slug}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log("saved", file);
}

await browser.close();

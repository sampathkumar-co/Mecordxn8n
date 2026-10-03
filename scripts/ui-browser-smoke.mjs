import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const base = String(process.env.UI_SMOKE_BASE_URL || "http://127.0.0.1:8080")
  .replace(/\/+$/, "");
const stamp = Date.now().toString(36);
const email = `ui-smoke-${stamp}@example.test`;
const password = "UI-Smoke-Password-12345";
const workspace = `UI Smoke ${stamp}`;
const outputDir = path.resolve("artifacts/ui-browser");
fs.mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const failures = [];

function captureRuntimeErrors(page, label) {
  let authenticated = false;
  page.on("pageerror", (error) => {
    failures.push(`${label}: pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const messageText = message.text();
    if (
      !authenticated &&
      /Failed to load resource:.*401 \(Unauthorized\)/i.test(messageText)
    ) {
      return;
    }
    failures.push(`${label}: console.error: ${messageText}`);
  });
  return () => { authenticated = true; };
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  if (overflow.scroll > overflow.viewport + 2) {
    failures.push(
      `${label}: horizontal overflow ${overflow.scroll} > ${overflow.viewport}`,
    );
  }
}

async function assertInteractiveNames(page, label) {
  const unnamed = await page.evaluate(() => {
    function accessibleName(element) {
      const aria = element.getAttribute("aria-label") ||
        element.getAttribute("aria-labelledby");
      if (aria) return aria.trim();
      if (element.id) {
        const label = document.querySelector(
          `label[for="${CSS.escape(element.id)}"]`,
        );
        if (label?.textContent?.trim()) return label.textContent.trim();
      }
      const wrapping = element.closest("label");
      if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
      if (element instanceof HTMLInputElement && element.placeholder) {
        return element.placeholder.trim();
      }
      return element.textContent?.trim() || "";
    }
    return [...document.querySelectorAll(
      "button:not([disabled]),a[href],input:not([type=hidden]),select,textarea",
    )]
      .filter((element) => !element.closest("[hidden]") && !element.classList.contains("hidden"))
      .filter((element) => !accessibleName(element))
      .map((element) => element.outerHTML.slice(0, 240));
  });
  if (unnamed.length) {
    failures.push(`${label}: unnamed interactive controls: ${unnamed.join(" | ")}`);
  }
}

const desktop = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const page = await desktop.newPage();
const markDesktopAuthenticated = captureRuntimeErrors(page, "desktop");

await page.goto(base + "/console", { waitUntil: "networkidle" });
await page.locator("#show-signup").click();
await page.locator("#signup-email").fill(email);
await page.locator("#signup-name").fill("UI Smoke Owner");
await page.locator("#signup-password").fill(password);
await page.locator("#signup-workspace").fill(workspace);
await page.locator("#signup-slug").fill("ui-smoke-" + stamp);
await Promise.all([
  page.waitForResponse((response) =>
    response.url().includes("/v1/platform/auth/signup") &&
    response.request().method() === "POST"
  ),
  page.locator("#signup-form button[type=submit]").click(),
]);
await page.locator("#app-view:not(.hidden)").waitFor({ timeout: 10_000 });
markDesktopAuthenticated();
await page.locator("#content").waitFor({ state: "visible" });
await assertNoHorizontalOverflow(page, "desktop-home");
await assertInteractiveNames(page, "desktop-home");

await page.keyboard.press("Control+K");
await page.locator("#command-palette[open]").waitFor({ timeout: 5_000 });
await page.keyboard.press("Escape");

await page.goto(base + "/console/workspace/access", {
  waitUntil: "networkidle",
});
await page.locator("#app-view:not(.hidden)").waitFor();
await page.locator("text=Team & access").first().waitFor();
await assertInteractiveNames(page, "desktop-access");
await page.screenshot({
  path: path.join(outputDir, "desktop-access.png"),
  fullPage: true,
});

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
});
const mobilePage = await mobile.newPage();
const markMobileAuthenticated = captureRuntimeErrors(mobilePage, "mobile");

await mobilePage.goto(base + "/console", { waitUntil: "networkidle" });
await mobilePage.locator("#login-email").fill(email);
await mobilePage.locator("#login-password").fill(password);
await Promise.all([
  mobilePage.waitForResponse((response) =>
    response.url().includes("/v1/platform/auth/login") &&
    response.request().method() === "POST"
  ),
  mobilePage.locator("#login-form button[type=submit]").click(),
]);
await mobilePage.locator("#app-view:not(.hidden)").waitFor({ timeout: 10_000 });
markMobileAuthenticated();
if (await mobilePage.locator("#toast.show").filter({ hasText: "Your session has expired." }).count()) {
  failures.push("mobile: fresh login retained a spurious session-expired toast");
}
await assertNoHorizontalOverflow(mobilePage, "mobile-home");
await mobilePage.locator("#mobile-menu").click();
await mobilePage.locator("#sidebar.mobile-open").waitFor();
await assertInteractiveNames(mobilePage, "mobile-home");
await mobilePage.screenshot({
  path: path.join(outputDir, "mobile-home.png"),
  fullPage: true,
});

await desktop.close();
await mobile.close();
await browser.close();

if (failures.length) {
  console.error(JSON.stringify({ status: "FAILED", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  status: "PASSED",
  desktop: true,
  mobile: true,
  deepLink: true,
  commandPalette: true,
  interactionNames: true,
  noHorizontalOverflow: true,
  screenshots: [
    "artifacts/ui-browser/desktop-access.png",
    "artifacts/ui-browser/mobile-home.png",
  ],
}));

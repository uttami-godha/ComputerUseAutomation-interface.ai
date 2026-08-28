import { chromium } from "playwright";
import type {
  Browser,
  BrowserContext,
  Page,
} from "playwright";

import { resolveLocator } from "./locator.ts";
import { perceive } from "./perception.ts";
import type {
  Action,
  LocatorStrategy,
  Observation,
  PerformResult,
  Surface,
} from "./surface.ts";

export type WebSurfaceOptions = {
  headed?: boolean;
  timeoutMs?: number;
  slowMoMs?: number;
};

export class WebSurface implements Surface {
  readonly kind = "web" as const;

  private browser: Browser;
  private context: BrowserContext;
  private page: Page;
  private timeoutMs: number;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    timeoutMs: number,
  ) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.timeoutMs = timeoutMs;
  }

  static async create(
    opts: WebSurfaceOptions = {},
  ): Promise<WebSurface> {
    const timeoutMs = opts.timeoutMs ?? 10_000;

    // Headed mode exists so a human can watch; at full speed the whole run
    // flashes by in well under a second. Default to a visible pace unless
    // the caller asked for something else.
    const slowMo =
      opts.slowMoMs ?? (opts.headed ? 400 : 0);

    const browser = await chromium.launch({
      headless: !opts.headed,
      slowMo,
    });

    const context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 900,
      },
    });

    const page = await context.newPage();

    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    if (opts.headed) {
      // The new window doesn't reliably take focus from the terminal that
      // launched it, so a human watching can easily miss it entirely.
      await page.bringToFront();
    }

    return new WebSurface(
      browser,
      context,
      page,
      timeoutMs,
    );
  }

  currentUrl(): string {
    return this.page.url();
  }

  async observe(): Promise<Observation> {
    return perceive(this.page);
  }

  async getVisibleText(): Promise<string> {
    return await this.page
      .locator("body")
      .innerText()
      .catch(() => "");
  }

  async screenshot(): Promise<Buffer> {
    return await this.page.screenshot({
      type: "png",
      fullPage: true,
    });
  }

  async perform(
    action: Action,
    strategies: LocatorStrategy[] = [],
  ): Promise<PerformResult> {
    try {
      switch (action.type) {
        case "navigate": {
          await this.page.goto(action.url, {
            waitUntil: "domcontentloaded",
          });

          return {
            ok: true,
          };
        }

        case "waitFor": {
          if (action.text) {
            await this.page
              .getByText(action.text, {
                exact: false,
              })
              .first()
              .waitFor({
                state: "visible",
                timeout:
                  action.ms ??
                  this.timeoutMs,
              });
          } else {
            await this.page.waitForTimeout(
              action.ms ?? 500,
            );
          }

          return {
            ok: true,
          };
        }

        case "assert": {
          const text =
            await this.getVisibleText();

          if (
            !text
              .toLowerCase()
              .includes(
                action.text.toLowerCase(),
              )
          ) {
            return {
              ok: false,
              code: "ASSERTION_FAILED",
              message:
                `expected visible text: ${action.text}`,
            };
          }

          return {
            ok: true,
          };
        }
      }

      const resolved =
        await resolveLocator(
          this.page,
          strategies,
        );

      if (!resolved) {
        const visualIndex =
          strategies.findIndex(
            (strategy) =>
              strategy.kind === "visual",
          );

        if (visualIndex >= 0) {
          const strategy =
            strategies[visualIndex]!;

          if (
            strategy.kind === "visual" &&
            action.type === "click"
          ) {
            await this.page.mouse.click(
              strategy.x,
              strategy.y,
            );

            return {
              ok: true,
              degraded: true,
              resolution: {
                strategyIndex:
                  visualIndex,
                strategyKind: "visual",
              },
            };
          }
        }

        return {
          ok: false,
          code: "TARGET_NOT_FOUND",
          message:
            "none of the target locator strategies resolved",
        };
      }

      const {
        locator,
        resolution,
      } = resolved;

      const degraded =
        resolution.strategyIndex > 0;

      switch (action.type) {
        case "click":
          await locator.click();

          return {
            ok: true,
            resolution,
            degraded,
          };

        case "type":
          await locator.fill(
            action.text,
          );

          return {
            ok: true,
            resolution,
            degraded,
          };

        case "select":
          await locator.selectOption(
            action.value,
          );

          return {
            ok: true,
            resolution,
            degraded,
          };

        case "press":
          await locator.press(
            action.key,
          );

          return {
            ok: true,
            resolution,
            degraded,
          };

        case "read":
          return {
            ok: true,
            value:
              await readValue(locator),
            resolution,
            degraded,
          };

        default:
          return {
            ok: false,
            code:
              "UNSUPPORTED_ACTION",
            message:
              "unsupported action",
          };
      }
    } catch (err) {
      return {
        ok: false,
        code: "SURFACE_ERROR",
        message:
          err instanceof Error
            ? err.message
            : String(err),
      };
    }
  }

  async close(): Promise<void> {
    await this.context
      .close()
      .catch(() => {});

    await this.browser
      .close()
      .catch(() => {});
  }
}

async function readValue(
  locator: any,
): Promise<string> {
  const tag = await locator
    .evaluate(
      (el: Element) =>
        el.tagName.toLowerCase(),
    )
    .catch(() => "");

  if (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select"
  ) {
    const value =
      await locator
        .inputValue()
        .catch(() => "");

    if (value) {
      return value.trim();
    }
  }

  const inner =
    await locator
      .innerText()
      .catch(() => "");

  if (inner) {
    return inner.trim();
  }

  const content =
    await locator
      .textContent()
      .catch(() => "");

  return content?.trim() ?? "";
}
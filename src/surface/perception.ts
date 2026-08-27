import type { Page } from "playwright";
import type {
  LocatorStrategy,
  Observation,
  PerceivedElement,
} from "./surface.ts";

type RawElement = {
  role: string;
  name: string;
  text: string;
  value?: string;
  tag: string;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  type?: string;
  href?: string;
};

export async function perceive(
  page: Page,
): Promise<Observation> {
  const url = page.url();
  const title = await page.title();

  const visibleText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const raw = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll(
        [
          "a",
          "button",
          "input",
          "select",
          "textarea",
          "[role]",
        ].join(","),
      ),
    );

    function visible(el: Element): boolean {
      const h = el as HTMLElement;
      const style = window.getComputedStyle(h);

      if (
        style.display === "none" ||
        style.visibility === "hidden"
      ) {
        return false;
      }

      const rect = h.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function labelFor(el: Element): string {
      const h = el as HTMLElement;
      const aria = h.getAttribute("aria-label");
      if (aria) return aria.trim();

      const id = h.getAttribute("id");

      if (id) {
        const label = document.querySelector(
          `label[for="${CSS.escape(id)}"]`,
        );

        if (label?.textContent?.trim()) {
          return label.textContent.trim();
        }
      }

      const wrapping = h.closest("label");
      if (wrapping?.textContent?.trim()) {
        return wrapping.textContent.trim();
      }

      const placeholder =
        h.getAttribute("placeholder");

      if (placeholder) return placeholder.trim();

      if (
        h instanceof HTMLInputElement &&
        h.type === "submit" &&
        h.value
      ) {
        return h.value;
      }

      return (h.textContent ?? "").trim();
    }

    function roleOf(el: Element): string {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;

      const tag = el.tagName.toLowerCase();

      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";

      if (tag === "input") {
        const type =
          (el.getAttribute("type") ?? "text")
            .toLowerCase();

        if (
          type === "button" ||
          type === "submit" ||
          type === "reset"
        ) {
          return "button";
        }

        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";

        return "textbox";
      }

      return tag;
    }

    return nodes
      .filter(visible)
      .slice(0, 80)
      .map((el) => {
        const h = el as HTMLInputElement;

        return {
          role: roleOf(el),
          name: labelFor(el),
          text: (el.textContent ?? "").trim(),
          value:
            "value" in h
              ? String(h.value ?? "")
              : undefined,
          tag: el.tagName.toLowerCase(),
          id: el.getAttribute("id") ?? undefined,
          ariaLabel:
            el.getAttribute("aria-label") ??
            undefined,
          placeholder:
            el.getAttribute("placeholder") ??
            undefined,
          type:
            el.getAttribute("type") ??
            undefined,
          href:
            el.getAttribute("href") ??
            undefined,
        };
      });
  }) as RawElement[];

  const elements: PerceivedElement[] =
    raw.map((el, index) => ({
      ref: `e${index + 1}`,
      role: el.role,
      name: el.name,
      ...(el.value
        ? { value: el.value }
        : {}),
      ...(el.text
        ? { text: el.text }
        : {}),
      strategies: strategiesFor(el),
    }));

  return {
    url,
    title,
    visibleText,
    elements,
  };
}

function strategiesFor(
  el: RawElement,
): LocatorStrategy[] {
  const out: LocatorStrategy[] = [];

  if (el.role && el.name) {
    out.push({
      kind: "role",
      role: el.role,
      name: el.name,
      exact: false,
    });
  }

  if (
    ["textbox", "combobox", "checkbox", "radio"].includes(
      el.role,
    ) &&
    el.name
  ) {
    out.push({
      kind: "label",
      text: el.name,
      exact: false,
    });

    out.push({
      kind: "nearLabel",
      label: el.name,
    });
  }

  if (
    ["button", "link"].includes(el.role) &&
    el.name
  ) {
    out.push({
      kind: "text",
      text: el.name,
      exact: false,
    });
  }

  if (el.id) {
    out.push({
      kind: "css",
      selector: `#${cssEscape(el.id)}`,
    });
  }

  return dedupe(out);
}

function dedupe(
  strategies: LocatorStrategy[],
): LocatorStrategy[] {
  const seen = new Set<string>();

  return strategies.filter((strategy) => {
    const key = JSON.stringify(strategy);

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function cssEscape(value: string): string {
  return value.replace(
    /[^a-zA-Z0-9_-]/g,
    (c) => `\\${c}`,
  );
}
import type { Locator } from "playwright";
import type {
  LocatorResolution,
  LocatorStrategy,
} from "./surface.ts";

export type ResolvedLocator = {
  locator: Locator;
  resolution: LocatorResolution;
};

function exact(v: boolean | undefined): boolean {
  return v ?? false;
}

async function usable(locator: Locator): Promise<boolean> {
  try {
    const count = await locator.count();
    if (count < 1) return false;

    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

export async function resolveLocator(
  page: any,
  strategies: LocatorStrategy[],
): Promise<ResolvedLocator | null> {
  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i]!;

    let locator: Locator | undefined;

    try {
      switch (strategy.kind) {
        case "role":
          locator = page.getByRole(
            strategy.role as any,
            strategy.name
              ? {
                  name: strategy.name,
                  exact: exact(strategy.exact),
                }
              : undefined,
          );
          break;

        case "label":
          locator = page.getByLabel(
            strategy.text,
            {
              exact: exact(strategy.exact),
            },
          );
          break;

        case "text":
          locator = page.getByText(
            strategy.text,
            {
              exact: exact(strategy.exact),
            },
          );
          break;

        case "nearLabel":
          locator = await resolveNearLabel(
            page,
            strategy.label,
          );
          break;

        case "css":
          locator = page.locator(strategy.selector);
          break;

        case "xpath":
          locator = page.locator(
            `xpath=${strategy.selector}`,
          );
          break;

        case "visual":
          // Coordinates are handled by PlaywrightSurface because there is
          // intentionally no DOM locator associated with a visual fallback.
          continue;
      }

      if (locator && await usable(locator)) {
        return {
          locator: locator.first(),
          resolution: {
            strategyIndex: i,
            strategyKind: strategy.kind,
          },
        };
      }
    } catch {
      // A broken selector or unsupported semantic locator must not prevent
      // trying the next strategy in the artifact's ordered fallback list.
      continue;
    }
  }

  return null;
}

async function resolveNearLabel(
  page: any,
  label: string,
): Promise<Locator> {
  // First prefer actual form-label semantics.
  const labelled = page.getByLabel(label, {
    exact: false,
  });

  if (await usable(labelled)) {
    return labelled.first();
  }

  // Legacy applications commonly use table rows:
  //
  //   <tr><td>Savings Balance</td><td>$4,210.55</td></tr>
  //
  // Find the cell containing the label and return its adjacent value cell.
  const tableValue = page.locator(
    `xpath=//*[self::td or self::th][contains(normalize-space(.), ${xpathLiteral(
      label,
    )})]/following-sibling::*[1]`,
  );

  if (await usable(tableValue)) {
    return tableValue.first();
  }

  // Another common legacy pattern is plain text followed by an input/control.
  const nearbyControl = page.locator(
    `xpath=//*[contains(normalize-space(.), ${xpathLiteral(
      label,
    )})]/following::*[self::input or self::select or self::textarea or self::button][1]`,
  );

  if (await usable(nearbyControl)) {
    return nearbyControl.first();
  }

  // Return the table candidate even when currently absent so callers retain a
  // normal Locator object; resolveLocator() will reject it as unusable.
  return tableValue.first();
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }

  if (!value.includes('"')) {
    return `"${value}"`;
  }

  return `concat(${value
    .split("'")
    .map((part, i, all) => {
      const quoted = `'${part}'`;
      return i === all.length - 1
        ? quoted
        : `${quoted}, "'", `;
    })
    .join("")})`;
}
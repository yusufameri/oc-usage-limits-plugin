import { afterEach, describe, expect, test } from "bun:test";

import { fetchCommandCodeUsage } from "@/providers/commandcode.ts";

const CREDITS_PATH = "/alpha/billing/credits";
const SUMMARY_PATH = "/alpha/usage/summary";

const originalFetch = globalThis.fetch;

const installRoutes = (
  routes: Readonly<Record<string, unknown>>
): readonly string[] => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const suffix = Object.keys(routes).find((key) => url.endsWith(key));
    const body = suffix === undefined ? {} : routes[suffix];
    return body instanceof Response ? body : Response.json(body);
  }) as typeof fetch;
  return seen;
};

const creditsBody = (fiveHourUsed: number, weeklyUsed: number) => ({
  credits: {
    creditThreshold: 0,
    freeCredits: 0,
    monthlyCredits: 70,
    purchasedCredits: 5,
  },
  windowLimits: {
    exceeded: null,
    fiveHour: {
      cap: 14,
      exceeded: false,
      resetAt: 1_789_810_659_226,
      used: fiveHourUsed,
    },
    limited: true,
    weekly: {
      cap: 35,
      exceeded: false,
      resetAt: 1_790_397_459_226,
      used: weeklyUsed,
    },
  },
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Command Code provider", () => {
  test("parses 5h, weekly, and derived monthly windows", async () => {
    const seen = installRoutes({
      [CREDITS_PATH]: creditsBody(7, 7),
      [SUMMARY_PATH]: { totalCost: 5, totalCredits: 5 },
    });

    const usage = await fetchCommandCodeUsage(
      undefined,
      { commandcode: { key: "cc-token" } },
      1000
    );

    expect(seen).toEqual([
      "https://api.commandcode.ai/alpha/billing/credits",
      "https://api.commandcode.ai/alpha/usage/summary",
    ]);
    expect(usage).toMatchObject({
      id: "commandcode",
      label: "Command Code",
    });
    expect(usage.windows).toMatchObject([
      { kind: "rolling", label: "5h", quota: { usedPercent: 50 } },
      { kind: "weekly", label: "weekly", quota: { usedPercent: 20 } },
      { kind: "monthly", label: "monthly", quota: { usedPercent: 6.25 } },
    ]);
    expect(usage.windows[0]?.resetsAt?.getTime()).toBe(1_789_810_659_226);
    expect(usage.windows[2]?.resetsAt).toBeNull();
  });

  test("shows 0% monthly when the summary request is unavailable", async () => {
    installRoutes({ [CREDITS_PATH]: creditsBody(1, 1) });

    const usage = await fetchCommandCodeUsage(
      undefined,
      { commandcode: { key: "cc-token" } },
      1000
    );

    expect(usage.windows).toMatchObject([
      { kind: "rolling" },
      { kind: "weekly" },
      { kind: "monthly", quota: { usedPercent: 0 } },
    ]);
  });

  test("supports a literal API key without OpenCode auth", async () => {
    const seen = installRoutes({ [CREDITS_PATH]: creditsBody(1, 1) });

    await fetchCommandCodeUsage({ apiKey: "literal-token" }, {}, 1000);

    expect(seen[0]).toBe("https://api.commandcode.ai/alpha/billing/credits");
  });

  test("rejects missing credentials and malformed responses", async () => {
    await expect(fetchCommandCodeUsage(undefined, {}, 1000)).rejects.toThrow(
      "missing Command Code key"
    );

    installRoutes({ [CREDITS_PATH]: { credits: {} } });
    await expect(
      fetchCommandCodeUsage(undefined, { commandcode: { key: "key" } }, 1000)
    ).rejects.toThrow("invalid Command Code usage");
  });
});

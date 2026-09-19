import { afterEach, describe, expect, test } from "bun:test";

import { fetchCommandCodeUsage } from "@/providers/commandcode.ts";

const originalFetch = globalThis.fetch;

// SAFETY: The mock implements the subset of fetch used by these tests.
const asFetch = <T>(value: T): typeof fetch => value as typeof fetch;

const installResponses = (
  responses: readonly Response[]
): readonly string[] => {
  const seen: string[] = [];
  let index = 0;
  globalThis.fetch = asFetch((input: string | URL | Request) => {
    seen.push(String(input));
    const response = responses[index] ?? new Response(null, { status: 502 });
    index += 1;
    return Promise.resolve(response);
  });
  return seen;
};

const creditsBody = (fiveHourUsed: number, weeklyUsed: number): Response =>
  Response.json({
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

const overCapBody = (): Response =>
  Response.json({
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
        exceeded: true,
        resetAt: 1_789_810_659_226,
        used: 20,
      },
      limited: true,
      weekly: {
        cap: 35,
        exceeded: false,
        resetAt: 1_790_397_459_226,
        used: 7,
      },
    },
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Command Code provider", () => {
  test("parses 5h, weekly, and derived monthly windows", async () => {
    const seen = installResponses([
      creditsBody(7, 7),
      Response.json({ totalCost: 5, totalCredits: 5 }),
    ]);

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

  test("clamps an exhausted bucket to 100% instead of dropping it", async () => {
    installResponses([overCapBody(), Response.json({ totalCredits: 5 })]);

    const usage = await fetchCommandCodeUsage(
      undefined,
      { commandcode: { key: "cc-token" } },
      1000
    );

    expect(usage.windows[0]).toMatchObject({
      kind: "rolling",
      quota: { usedPercent: 100 },
    });
  });

  test("keeps an unknown monthly quota when the summary request fails", async () => {
    installResponses([creditsBody(1, 1), new Response(null, { status: 500 })]);

    const usage = await fetchCommandCodeUsage(
      undefined,
      { commandcode: { key: "cc-token" } },
      1000
    );

    expect(usage.windows).toMatchObject([
      { kind: "rolling" },
      { kind: "weekly" },
      { kind: "monthly", quota: { _tag: "Unknown" } },
    ]);
  });

  test("supports a literal API key without OpenCode auth", async () => {
    const seen = installResponses([creditsBody(1, 1)]);

    await fetchCommandCodeUsage({ apiKey: "literal-token" }, {}, 1000);

    expect(seen[0]).toBe("https://api.commandcode.ai/alpha/billing/credits");
  });

  test("rejects missing credentials and malformed responses", async () => {
    await expect(fetchCommandCodeUsage(undefined, {}, 1000)).rejects.toThrow(
      "missing Command Code key"
    );

    installResponses([Response.json({ credits: {} })]);
    await expect(
      fetchCommandCodeUsage(undefined, { commandcode: { key: "key" } }, 1000)
    ).rejects.toThrow("invalid Command Code usage");
  });
});

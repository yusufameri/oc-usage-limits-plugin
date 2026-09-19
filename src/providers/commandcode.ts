import { Effect, Redacted, Result } from "effect";

import { commandCodeProviderConfigSchema } from "@/config-schema.ts";
import {
  MissingProviderCredentialsError,
  ProviderResponseDecodeError,
} from "@/errors.ts";
import type { ProviderDefinition } from "@/providers/definition.ts";
import { ProviderClock } from "@/providers/runtime/clock.ts";
import { ProviderEnvironment } from "@/providers/runtime/environment.ts";
import { ProviderFileSystem } from "@/providers/runtime/filesystem.ts";
import { ProviderHttpClient } from "@/providers/runtime/http.ts";
import { ProviderRuntimeLive } from "@/providers/runtime/index.ts";
import type {
  CommandCodeProviderConfig,
  OpenCodeAuth,
  ProviderUsage,
  UsageWindow,
} from "@/types.ts";
import type { ResetInstant } from "@/usage.ts";
import {
  parseUsageCount,
  parseUsagePercentage,
  percentageQuota,
  resetInstantOrNull,
} from "@/usage.ts";
import { isRecord } from "@/utils.ts";
import type { JsonValue } from "@/utils.ts";
import { resolveHttpsBaseUrl } from "@/utils/url.ts";

/** Default Command Code API base URL. */
const DEFAULT_COMMANDCODE_BASE_URL = "https://api.commandcode.ai";
/** Credit-window usage endpoint (the same source the CLI's `/usage` reads). */
const COMMANDCODE_CREDITS_PATH = "/alpha/billing/credits";
/** Billing-period spend endpoint used to derive the monthly credit window. */
const COMMANDCODE_USAGE_SUMMARY_PATH = "/alpha/usage/summary";
const COMMANDCODE_PROVIDER_ID = "commandcode" as const;
const DECODE_RESPONSE = "decode-response";

type ProviderPayload = Readonly<Record<string, JsonValue>>;

/**
 * Extracts a Command Code API key from any supported auth object shape.
 *
 * Accepts the nested `commandcode` block used by OpenCode auth and direct key
 * fields so the adapter stays provider-agnostic.
 *
 * @param value - Unknown auth payload to inspect.
 * @returns The first recognized API key.
 */
const keyFromCommandCodeAuth = (
  value: OpenCodeAuth | JsonValue,
  credential: (
    value: JsonValue | Redacted.Redacted<string> | undefined
  ) => Redacted.Redacted<string> | undefined
): Redacted.Redacted<string> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const directKey = credential(value.key);
  if (directKey) {
    return directKey;
  }

  const directApiKey = credential(value.apiKey);
  if (directApiKey) {
    return directApiKey;
  }

  const { commandcode: commandCode } = value;
  if (isRecord(commandCode)) {
    const key = credential(commandCode.key);
    if (key) {
      return key;
    }
    const apiKey = credential(commandCode.apiKey);
    if (apiKey) {
      return apiKey;
    }
  }

  return undefined;
};

/**
 * Attempts to load a Command Code API key from a configured auth path.
 *
 * @param authPath - Optional auth file path.
 * @returns A Command Code API key when the file exists and contains one.
 */
const readCommandCodeAuthPathKey = (
  authPath: string | undefined
): Effect.Effect<
  Redacted.Redacted<string> | undefined,
  never,
  ProviderEnvironment | ProviderFileSystem
> => {
  if (!authPath) {
    return Effect.succeed<undefined>(globalThis.undefined);
  }
  return Effect.gen(function* loadCommandCodeAuthPathKey() {
    const files = yield* ProviderFileSystem;
    const environment = yield* ProviderEnvironment;
    const auth = yield* files.readJson({
      path: authPath,
      providerID: COMMANDCODE_PROVIDER_ID,
    });
    return keyFromCommandCodeAuth(auth, environment.credential);
  }).pipe(
    Effect.catchCause(() => Effect.succeed<undefined>(globalThis.undefined))
  );
};

/**
 * Converts a millisecond epoch reset timestamp into a canonical instant.
 *
 * @param value - Provider-reported epoch milliseconds.
 * @returns A valid reset instant, or `null` when absent or invalid.
 */
const resetFromEpochMs = (
  value: JsonValue | undefined
): ResetInstant | null => {
  const parsed = parseUsageCount(value);
  return Result.isFailure(parsed)
    ? null
    : resetInstantOrNull(new Date(parsed.success));
};

/**
 * Builds one usage window from a Command Code credit bucket.
 *
 * Command Code reports credit spend as `used` against a `cap` rather than a
 * percentage, so the used percentage is derived from the ratio.
 *
 * @param value - `fiveHour` or `weekly` bucket from `windowLimits`.
 * @param kind - Normalized window kind.
 * @param label - Display label for the window.
 * @returns A normalized window, or `null` when the bucket is unusable.
 */
const commandCodeWindow = (
  value: JsonValue | undefined,
  kind: UsageWindow["kind"],
  label: string
): UsageWindow | null => {
  if (!isRecord(value)) {
    return null;
  }
  const parsedUsed = parseUsageCount(value.used);
  const parsedCap = parseUsageCount(value.cap);
  if (Result.isFailure(parsedUsed) || Result.isFailure(parsedCap)) {
    return null;
  }
  if (parsedCap.success <= 0 || parsedUsed.success > parsedCap.success) {
    return null;
  }
  const parsedPercent = parseUsagePercentage(
    (parsedUsed.success / parsedCap.success) * 100
  );
  if (Result.isFailure(parsedPercent)) {
    return null;
  }
  return {
    kind,
    label,
    quota: percentageQuota(parsedPercent.success),
    resetsAt: resetFromEpochMs(value.resetAt),
  };
};

/**
 * Reads the credits spent in the current billing period.
 *
 * @param payload - Parsed `/alpha/usage/summary` payload, or null when the
 *   request failed.
 * @returns Non-negative spent credits, or `null` when unreported.
 */
const summarySpentCredits = (payload: JsonValue | null): number | null => {
  if (!isRecord(payload)) {
    return null;
  }
  const spent = parseUsageCount(payload.totalCredits ?? payload.totalCost);
  return Result.isFailure(spent) ? null : spent.success;
};

/**
 * Builds the monthly credit window.
 *
 * Command Code exposes no monthly rate-limit bucket; the monthly view is the
 * plan's credit pool. The remaining pool is `monthlyCredits + purchasedCredits
 * + freeCredits` and the billing-period spend comes from the usage summary, so
 * the used percentage is `spent / (remaining + spent)`.
 *
 * @param credits - `credits` object from the billing payload.
 * @param spent - Credits spent this billing period, or null when unknown.
 * @returns A normalized monthly window, or `null` when no pool is reported.
 */
const commandCodeMonthlyWindow = (
  credits: JsonValue | undefined,
  spent: number | null
): UsageWindow | null => {
  if (!isRecord(credits)) {
    return null;
  }
  const monthly = parseUsageCount(credits.monthlyCredits);
  const purchased = parseUsageCount(credits.purchasedCredits);
  const free = parseUsageCount(credits.freeCredits);
  if (
    Result.isFailure(monthly) ||
    Result.isFailure(purchased) ||
    Result.isFailure(free)
  ) {
    return null;
  }
  const remaining = monthly.success + purchased.success + free.success;
  const used = spent ?? 0;
  const total = remaining + used;
  if (total <= 0) {
    return null;
  }
  const parsedPercent = parseUsagePercentage((used / total) * 100);
  if (Result.isFailure(parsedPercent)) {
    return null;
  }
  return {
    kind: "monthly",
    label: "monthly",
    quota: percentageQuota(parsedPercent.success),
    resetsAt: null,
  };
};

/**
 * Fetches and normalizes Command Code credit-window usage.
 *
 * Credential lookup checks, in order, the configured auth path, OpenCode auth,
 * and a configured literal or environment-backed API key.
 *
 * @param config - Optional Command Code provider configuration.
 * @param openCodeAuth - Shared OpenCode auth payload.
 * @param timeoutMs - Request timeout in milliseconds.
 * @returns Normalized Command Code usage data.
 * @throws {Error} When no API key is available or the provider response is invalid.
 */
const fetchCommandCodeUsageEffect = (
  config: CommandCodeProviderConfig | undefined,
  openCodeAuth: OpenCodeAuth,
  timeoutMs: number
): ReturnType<ProviderDefinition<"commandcode">["fetch"]> =>
  Effect.gen(function* runFetchCommandCodeUsage() {
    const environment = yield* ProviderEnvironment;
    const http = yield* ProviderHttpClient;
    const clock = yield* ProviderClock;
    const baseUrl = resolveHttpsBaseUrl(
      config?.baseUrl,
      DEFAULT_COMMANDCODE_BASE_URL
    );
    const isOfficialHost = new URL(baseUrl).hostname === "api.commandcode.ai";
    const configuredKey = environment.resolveCredential(config?.apiKey);
    const configuredFileKey = yield* readCommandCodeAuthPathKey(
      config?.authPath
    );
    const authKey = keyFromCommandCodeAuth(
      openCodeAuth,
      environment.credential
    );
    const apiKey =
      configuredFileKey ??
      (isOfficialHost ? (authKey ?? configuredKey) : configuredKey);
    if (!apiKey) {
      return yield* new MissingProviderCredentialsError({
        operation: "fetch-usage",
        providerID: COMMANDCODE_PROVIDER_ID,
      });
    }

    const payload = yield* http.requestJson({
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${Redacted.value(apiKey)}`,
      },
      method: "GET",
      providerID: COMMANDCODE_PROVIDER_ID,
      timeoutMs,
      url: `${baseUrl}${COMMANDCODE_CREDITS_PATH}`,
    });
    if (!isRecord(payload) || !isRecord(payload.windowLimits)) {
      return yield* new ProviderResponseDecodeError({
        cause: "schema",
        operation: DECODE_RESPONSE,
        providerID: COMMANDCODE_PROVIDER_ID,
      });
    }

    const summary = yield* http
      .requestJson({
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${Redacted.value(apiKey)}`,
        },
        method: "GET",
        providerID: COMMANDCODE_PROVIDER_ID,
        timeoutMs,
        url: `${baseUrl}${COMMANDCODE_USAGE_SUMMARY_PATH}`,
      })
      .pipe(Effect.catchCause(() => Effect.succeed<JsonValue | null>(null)));

    // SAFETY: windowLimits was validated as a record by the guard above.
    const limits = payload.windowLimits as ProviderPayload;
    const windows = [
      commandCodeWindow(limits.fiveHour, "rolling", "5h"),
      commandCodeWindow(limits.weekly, "weekly", "weekly"),
      commandCodeMonthlyWindow(payload.credits, summarySpentCredits(summary)),
    ].filter((window): window is UsageWindow => window !== null);
    if (windows.length === 0) {
      return yield* new ProviderResponseDecodeError({
        cause: "schema",
        operation: DECODE_RESPONSE,
        providerID: COMMANDCODE_PROVIDER_ID,
      });
    }

    return {
      capturedAt: yield* clock.now,
      id: COMMANDCODE_PROVIDER_ID,
      label: config?.label ?? "Command Code",
      windows,
    };
  });

/** Stable Promise export for direct consumers of the provider adapter. */
export const fetchCommandCodeUsage = (
  config: CommandCodeProviderConfig | undefined,
  openCodeAuth: OpenCodeAuth,
  timeoutMs: number
): Promise<ProviderUsage<"commandcode">> =>
  Effect.runPromise(
    fetchCommandCodeUsageEffect(config, openCodeAuth, timeoutMs).pipe(
      Effect.provide(ProviderRuntimeLive)
    )
  );

/** Plugin registration for the Command Code provider adapter. */
export const commandCodeProvider = {
  capabilities: { customBaseUrl: true, transport: "http" },
  configSchema: commandCodeProviderConfigSchema,
  defaultLabel: "Command Code",
  fetch: fetchCommandCodeUsageEffect,
  footerWindowKind: "rolling",
  id: COMMANDCODE_PROVIDER_ID,
  openCodeProviderIDs: [COMMANDCODE_PROVIDER_ID],
} as const satisfies ProviderDefinition<"commandcode">;

"use server";

import { cookies } from "next/headers";

import { getModel, parseSettings } from "./catalog";
import type { GenerationPlane } from "./catalog/types";
import {
  MissingCredentialsError,
  PLATFORM_KEY_COOKIE,
  PLATFORM_KEY_COOKIE_OPTIONS,
  decodeCredentials,
  encodeCredentials,
  parseCredentialInput,
} from "./credentials";
import { PlatformError, createPlatformClient } from "./platform";
import type { QueuedGeneration, StatusResult } from "./platform";
import { toPlatform } from "./to-platform";

export async function savePlatformCredentials(data: unknown) {
  const { apiKey } = parseCredentialInput(data);
  const jar = await cookies();
  jar.set(PLATFORM_KEY_COOKIE, encodeCredentials(apiKey), PLATFORM_KEY_COOKIE_OPTIONS);
}

export async function clearPlatformCredentials() {
  const jar = await cookies();
  jar.set(PLATFORM_KEY_COOKIE, "", { ...PLATFORM_KEY_COOKIE_OPTIONS, maxAge: 0 });
}

export async function hasPlatformCredentials() {
  return (await readStoredCredentials()) !== null;
}

export type SubmitResult =
  | { ok: true; queued: QueuedGeneration }
  | { ok: false; error: string; missingKey?: boolean };

/** Returns its failure rather than throwing it: a production build replaces a
    thrown server-action error with a generic React digest, so the reason
    (rejected key, no credits, wrong API origin) would never reach the page. */
export async function submitGeneration(plane: GenerationPlane): Promise<SubmitResult> {
  try {
    const model = getModel(plane.model);
    const parsed: GenerationPlane = {
      ...plane,
      settings: parseSettings(model, plane.settings),
    };
    const { path, body } = toPlatform(parsed);
    const queued = await createPlatformClient(await readCredentials()).submit(path, body);
    return { ok: true, queued };
  } catch (caught) {
    console.error("[generate] submit failed", caught instanceof Error ? caught.message : caught);
    if (caught instanceof MissingCredentialsError) {
      return { ok: false, error: caught.message, missingKey: true };
    }
    return { ok: false, error: explainFailure(caught) };
  }
}

function explainFailure(caught: unknown): string {
  if (caught instanceof PlatformError) {
    const detail = caught.message;
    if (caught.status === 401 || caught.status === 403) {
      return `the platform rejected the key (${caught.status}: ${detail}) — check it is the right id:secret`;
    }
    if (caught.status === 402) return `the platform needs more credits (402: ${detail})`;
    if (caught.status === 404) {
      return `the platform has nothing at this address (404) — check HF_API_BASE_URL in the deployment settings`;
    }
    return `${detail} (${caught.status})`;
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  if (message === "Missing HF_API_BASE_URL") {
    return "HF_API_BASE_URL is not set in the deployment settings";
  }
  if (message === "fetch failed" || message.includes("ENOTFOUND") || message.includes("ECONNREFUSED")) {
    return "could not reach the platform at HF_API_BASE_URL — check the address in the deployment settings";
  }
  return message;
}

/** Every request in flight, answered in one round trip. Next dispatches server
    actions one at a time per client, so a poll per run would queue ahead of the
    next submit — the fan-out belongs on this side of the call, where it is
    genuinely parallel. */
export async function getGenerationStatuses(data: unknown): Promise<StatusResult[]> {
  const requestIds = parseRequestIds(data);
  let client: ReturnType<typeof createPlatformClient>;
  try {
    client = createPlatformClient(await readCredentials());
  } catch (caught) {
    const error = explainFailure(caught);
    return requestIds.map((requestId) => ({ requestId, error }));
  }
  return Promise.all(
    requestIds.map(async (requestId): Promise<StatusResult> => {
      try {
        return { requestId, status: await client.status(requestId) };
      } catch (caught) {
        return { requestId, error: explainFailure(caught) };
      }
    }),
  );
}

async function readStoredCredentials() {
  const jar = await cookies();
  return decodeCredentials(jar.get(PLATFORM_KEY_COOKIE)?.value);
}

async function readCredentials() {
  const stored = await readStoredCredentials();
  if (!stored) throw new MissingCredentialsError();
  const baseUrl = process.env.HF_API_BASE_URL;
  if (!baseUrl) throw new Error("Missing HF_API_BASE_URL");
  return { ...stored, baseUrl: withSiblingOrigin(baseUrl) };
}

/** Higgsfield serves its API from two origins and a key can belong to either,
    so a deployment configured with one also tries the other. */
const HIGGSFIELD_ORIGINS = ["https://api.higgsfield.ai", "https://platform.higgsfield.ai"];

function withSiblingOrigin(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (!HIGGSFIELD_ORIGINS.includes(trimmed)) return [trimmed];
  return [trimmed, ...HIGGSFIELD_ORIGINS.filter((origin) => origin !== trimmed)];
}

function parseRequestIds(data: unknown): string[] {
  const payload = asObject(data, "Invalid status payload");
  const requestIds = payload.requestIds;
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    throw new Error("Invalid request ids");
  }
  return requestIds.map((requestId) => {
    if (typeof requestId !== "string" || !requestId) throw new Error("Invalid request id");
    return requestId;
  });
}

function asObject(data: unknown, message: string): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(message);
  return data as Record<string, unknown>;
}

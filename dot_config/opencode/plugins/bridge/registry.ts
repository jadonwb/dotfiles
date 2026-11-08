// Shared bridge registry.
//
// Every OpenCode plugin here is its own module instance, so domain bookkeeping
// cannot live in module scope: the bridge plugin and the domain plugins would
// each get a private copy. The registry is therefore stored on `globalThis`
// under a symbol, which is shared by all plugins in the same server process.
//
// A domain plugin calls `registerDomain` instead of `ctx.rpc.register`
// directly. That keeps one place responsible for registration and for the
// `describe` handshake, without either side knowing the other's internals.

import { randomUUID } from "node:crypto";

const PROTOCOL = 1;

const REGISTRY = Symbol.for("opencode.bridge.registry");

type Registry = {
  domains: Map<string, string>;
};

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  let current = holder[REGISTRY];
  if (!current) {
    current = { domains: new Map() };
    holder[REGISTRY] = current;
  }
  return current;
}

/** Client-generated request ID used for server-side deduplication. */
export function mintRequestID(requestID: unknown): string {
  if (requestID === undefined || requestID === null || requestID === "") {
    return `req_${randomUUID().replaceAll("-", "")}`;
  }
  return String(requestID);
}

type RpcRegistrar = {
  register: (
    contract: unknown,
    handlers: Record<string, unknown>,
  ) => Promise<unknown>;
};

/**
 * Register one RPC domain and record it for the bridge handshake.
 *
 * `description` is frontend metadata only; it never reaches the model.
 */
export async function registerDomain(
  ctx: { rpc: RpcRegistrar },
  input: {
    contract: { id: string };
    description: string;
    handlers: Record<string, unknown>;
  },
): Promise<void> {
  const { domains } = registry();
  const previous = domains.get(input.contract.id);
  domains.set(input.contract.id, input.description);
  try {
    await ctx.rpc.register(input.contract, input.handlers);
  } catch (error) {
    // Do not advertise a domain that failed to register.
    if (previous === undefined) {
      domains.delete(input.contract.id);
    } else {
      domains.set(input.contract.id, previous);
    }
    throw error;
  }
}

/** Snapshot for `personal.bridge.describe`. Deterministic order. */
export function describeBridge(): {
  protocol: number;
  domains: Array<{ id: string; description: string }>;
} {
  const { domains } = registry();
  return {
    protocol: PROTOCOL,
    domains: [...domains.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, description]) => ({ id, description })),
  };
}

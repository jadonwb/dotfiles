// Bridge plugin: exposes `personal.bridge` so a frontend can discover the RPC
// domains this server serves.
//
// This is the seam between Neovim and the domains. It deliberately owns no
// product behavior: artifacts (and later session control or UI commands) stay
// in their own plugins and register through ./registry.ts.

import { Bridge } from "./contract.ts";
import { describeBridge } from "./registry.ts";

export default {
  id: "personal.bridge",
  async setup(ctx) {
    await ctx.rpc.register(Bridge, {
      describe: async () => describeBridge(),
    });
  },
};

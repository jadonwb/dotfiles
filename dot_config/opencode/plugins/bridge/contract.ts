// Bridge contract: the frontend-facing handshake for the OpenCode side of the
// Neovim <-> OpenCode channel.
//
// This namespace is plumbing, not product behavior. It exists so a frontend can
// discover which RPC domains this process serves and which protocol revision it
// speaks before issuing domain calls. Future capabilities (Neovim UI commands,
// session control) can extend `describe` or add sibling methods without
// touching any domain contract.
//
// The HTTP surface is POST /api/rpc/personal.bridge/<method> with {input} ->
// {output}; the `location` deepObject query selects the registered instance.

const domain = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "RPC namespace, for example personal.artifacts",
    },
    description: {
      type: "string",
      description: "one-line human summary of the domain",
    },
  },
  required: ["id", "description"],
  additionalProperties: false,
};

const Bridge = {
  id: "personal.bridge",
  events: {},
  methods: {
    // Strict empty-object input: clients always send the normalized
    // {"input":{}} object body.
    describe: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          protocol: { type: "number", description: "bridge protocol revision" },
          domains: { type: "array", items: domain },
        },
        required: ["protocol", "domains"],
        additionalProperties: false,
      },
      errors: {
        io: { type: "object", properties: { detail: { type: "string" } } },
      },
    },
  },
};

export { Bridge };

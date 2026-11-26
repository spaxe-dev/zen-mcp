import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalPolicyJson,
  parsePolicyText,
  serializePolicy,
  validatePolicy,
} from "../../src/shared/policy-schema.js";
import { policyDigest } from "../../src/shared/policy-digest.js";
import {
  CAPABILITY_IDS,
  createPolicy,
  type Policy,
} from "../../src/shared/policy.js";

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    mode: "restricted",
    websites: { default: "allow" },
    ...overrides,
  };
}

function rejected(value: unknown, code: string): void {
  const result = validatePolicy(value);
  assert.equal(result.ok, false, JSON.stringify(value));
  if (!result.ok) assert.equal(result.code, code, result.message);
}

function accepted(value: unknown): Policy {
  const result = validatePolicy(value);
  if (!result.ok) throw new Error(result.message);
  return result.policy;
}

describe("policy schema strictness", () => {
  it("accepts the minimal document and fills the optional sections", () => {
    const policy = accepted(document());
    assert.equal(policy.schemaVersion, 1);
    assert.equal(policy.mode, "restricted");
    assert.deepEqual(policy.capabilities, {});
    assert.deepEqual(policy.restrictions, {});
    assert.deepEqual(policy.websites, {
      default: "allow",
      allow: [],
      block: [],
      rules: [],
    });
  });

  it("rejects non-objects, arrays and null", () => {
    for (const value of [null, [], "policy", 1, true]) {
      rejected(value, "schema_invalid");
    }
  });

  it("rejects unknown keys at every level", () => {
    rejected(document({ extra: true }), "schema_invalid");
    rejected(document({ pause: true }), "schema_invalid");
    rejected(
      document({ websites: { default: "allow", host: "example.com" } }),
      "schema_invalid"
    );
    rejected(
      document({
        websites: {
          default: "allow",
          rules: [{ host: "example.com", extra: true }],
        },
      }),
      "schema_invalid"
    );
  });

  it("rejects unknown capabilities instead of ignoring them", () => {
    rejected(document({ capabilities: { "nope.read": "allow" } }), "schema_invalid");
    rejected(document({ restrictions: { "nope.read": "deny" } }), "schema_invalid");
    rejected(
      document({
        websites: {
          default: "allow",
          rules: [{ host: "example.com", capabilities: { "nope.read": "deny" } }],
        },
      }),
      "schema_invalid"
    );
  });

  it("accepts every registered capability id", () => {
    const capabilities = Object.fromEntries(
      CAPABILITY_IDS.map((id) => [id, "deny"])
    );
    const policy = accepted(document({ capabilities }));
    assert.equal(Object.keys(policy.capabilities).length, CAPABILITY_IDS.length);
  });

  it("only accepts deny in restrictions", () => {
    rejected(document({ restrictions: { "page.click": "allow" } }), "schema_invalid");
    const policy = accepted(document({ restrictions: { "page.click": "deny" } }));
    assert.equal(policy.restrictions["page.click"], "deny");
  });

  it("only accepts allow and deny as access values", () => {
    for (const value of ["yes", true, 1, null]) {
      rejected(document({ capabilities: { "page.click": value } }), "schema_invalid");
    }
  });

  it("rejects a permanent allow in the top level and in a site rule", () => {
    for (const id of [
      "download.write",
      "browser.internalPages",
      "screenshot.capture",
    ]) {
      const top = validatePolicy(document({ capabilities: { [id]: "allow" } }));
      assert.equal(top.ok, false);
      if (!top.ok) assert.equal(top.code, "permanent_deny");

      const rule = validatePolicy(
        document({
          websites: {
            default: "allow",
            rules: [{ host: "example.com", capabilities: { [id]: "allow" } }],
          },
        })
      );
      assert.equal(rule.ok, false);
      if (!rule.ok) assert.equal(rule.code, "permanent_deny");
    }
  });

  it("allows permanent deny restrictions", () => {
    const policy = accepted(
      document({
        mode: "full",
        restrictions: { "download.write": "deny" },
      })
    );
    assert.equal(policy.restrictions["download.write"], "deny");
  });
});

describe("metadata validation", () => {
  it("rejects unsupported and missing schema versions", () => {
    rejected(document({ schemaVersion: 2 }), "unsupported_schema");
    rejected(document({ schemaVersion: 0 }), "unsupported_schema");
    rejected(document({ schemaVersion: "1" }), "schema_invalid");
    const { schemaVersion: _ignored, ...withoutVersion } = document();
    rejected(withoutVersion, "schema_invalid");
  });

  it("bounds and types the revision", () => {
    for (const revision of [0, -1, 1.5, "1", 2_147_483_648]) {
      rejected(document({ revision }), "schema_invalid");
    }
    assert.equal(accepted(document({ revision: 2_147_483_647 })).revision, 2_147_483_647);
  });

  it("requires an ISO timestamp", () => {
    for (const updatedAt of ["2026-01-01", "", "yesterday", 1]) {
      rejected(document({ updatedAt }), "schema_invalid");
    }
  });

  it("restricts the writer enum", () => {
    rejected(document({ writer: "agent" }), "schema_invalid");
    for (const writer of ["cli", "control-center", "json", "migration"]) {
      assert.equal(accepted(document({ writer })).writer, writer);
    }
  });

  it("restricts the mode enum", () => {
    rejected(document({ mode: "admin" }), "schema_invalid");
    rejected(document({ mode: "Restricted" }), "schema_invalid");
  });
});

describe("host validation", () => {
  it("rejects malformed hosts", () => {
    for (const host of [
      "",
      "https://example.com",
      "example.com/path",
      "example.com:443",
      "user@example.com",
      "exa mple.com",
      "*.example.com/path",
      "*.",
      "-bad.example.com",
      "example..com",
      "exa_mple.com",
      "example.com?x=1",
    ]) {
      rejected(
        document({ websites: { default: "allow", allow: [host] } }),
        "schema_invalid"
      );
    }
  });

  it("accepts bare, wildcard and mixed-case hosts and normalizes them", () => {
    const policy = accepted(
      document({
        websites: {
          default: "allow",
          allow: ["Example.COM", "*.Docs.Test", "leading.test"],
        },
      })
    );
    assert.deepEqual(policy.websites.allow, [
      "example.com",
      "*.docs.test",
      "leading.test",
    ]);
  });

  it("rejects duplicate and conflicting hosts", () => {
    rejected(
      document({ websites: { default: "allow", allow: ["a.test", "a.test"] } }),
      "duplicate_host"
    );
    rejected(
      document({
        websites: {
          default: "allow",
          allow: ["Example.com", "example.com"],
        },
      }),
      "duplicate_host"
    );
    rejected(
      document({ websites: { default: "allow", block: ["a.test", "A.test"] } }),
      "duplicate_host"
    );
    rejected(
      document({
        websites: { default: "allow", allow: ["a.test"], block: ["a.test"] },
      }),
      "duplicate_host"
    );
    rejected(
      document({
        websites: {
          default: "allow",
          rules: [
            { host: "a.test", capabilities: { "nav.open": "deny" } },
            { host: "A.test", capabilities: { "page.read": "deny" } },
          ],
        },
      }),
      "duplicate_host"
    );
  });

  it("caps website lists and rules", () => {
    const many = Array.from({ length: 1001 }, (_, index) => `h${index}.test`);
    rejected(
      document({ websites: { default: "allow", allow: many } }),
      "schema_invalid"
    );
    const rules = Array.from({ length: 501 }, (_, index) => ({
      host: `r${index}.test`,
      capabilities: { "page.read": "deny" as const },
    }));
    rejected(document({ websites: { default: "allow", rules } }), "schema_invalid");
  });
});

describe("parsing and canonical form", () => {
  it("rejects invalid JSON without echoing the content", () => {
    const result = parsePolicyText('{"secret":"do-not-repeat",');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "invalid_json");
      assert.doesNotMatch(result.message, /do-not-repeat/);
    }
  });

  it("parses a valid serialized policy back to the same document", () => {
    const policy = createPolicy({
      mode: "full",
      now: new Date("2026-01-01T00:00:00.000Z"),
      capabilities: { "page.click": "deny" },
      restrictions: { "page.type": "deny" },
      websites: {
        default: "deny",
        allow: ["example.com"],
        block: ["blocked.test"],
        rules: [
          { host: "docs.example.com", capabilities: { "page.read": "allow" } },
        ],
      },
    });
    const result = parsePolicyText(serializePolicy(policy));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.policy, policy);
    assert.equal(serializePolicy(policy).endsWith("\n"), true);
  });

  it("keeps the digest stable across key order", () => {
    const first = createPolicy({ mode: "normal" });
    const reordered = {
      websites: first.websites,
      restrictions: first.restrictions,
      capabilities: first.capabilities,
      mode: first.mode,
      writer: first.writer,
      updatedAt: first.updatedAt,
      revision: first.revision,
      schemaVersion: first.schemaVersion,
    } as Policy;
    if (reordered.writer === undefined) delete (reordered as { writer?: string }).writer;
    assert.equal(policyDigest(first), policyDigest(reordered));
    assert.equal(canonicalPolicyJson(first), canonicalPolicyJson(reordered));
  });

  it("changes the digest when the policy changes", () => {
    const base = createPolicy({ mode: "normal" });
    const changed = createPolicy({ mode: "full" });
    assert.notEqual(policyDigest(base), policyDigest(changed));
  });

  it("produces a 64-character sha256 digest", () => {
    assert.match(policyDigest(createPolicy()), /^[0-9a-f]{64}$/);
  });
});

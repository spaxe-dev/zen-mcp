import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSensitiveDescriptor } from "../../src/shared/sensitive.js";

describe("sensitive field classification", () => {
  it("classifies secret input types", () => {
    for (const type of ["password", "file", "email", "tel"]) {
      assert.equal(isSensitiveDescriptor({ type }), true, type);
    }
    for (const type of ["text", "search", "number", "checkbox"]) {
      assert.equal(isSensitiveDescriptor({ type }), false, type);
    }
  });

  it("classifies sensitive autocomplete tokens", () => {
    for (const autocomplete of [
      "current-password",
      "new-password",
      "one-time-code",
      "cc-number",
      "cc-csc",
      "cc-exp",
      "email",
      "tel-national",
      "username",
      "street-address",
      "address-line1",
    ]) {
      assert.equal(isSensitiveDescriptor({ autocomplete }), true, autocomplete);
    }
    assert.equal(isSensitiveDescriptor({ autocomplete: "name" }), false);
    assert.equal(isSensitiveDescriptor({ autocomplete: "organization" }), false);
  });

  it("classifies email and telephone input modes", () => {
    assert.equal(isSensitiveDescriptor({ inputMode: "email" }), true);
    assert.equal(isSensitiveDescriptor({ inputMode: "tel" }), true);
    assert.equal(isSensitiveDescriptor({ inputMode: "text" }), false);
  });

  it("classifies hints in names, ids, placeholders and labels", () => {
    const cases: Array<Record<string, string>> = [
      { name: "password" },
      { name: "user_pwd" },
      { id: "passcode" },
      { name: "secret" },
      { name: "api_token" },
      { name: "otp" },
      { name: "one-time-code" },
      { name: "verification" },
      { placeholder: "Security code" },
      { name: "cvv" },
      { name: "card-number" },
      { name: "credit_card" },
      { name: "IBAN" },
      { name: "routing" },
      { name: "account-number" },
      { name: "ssn" },
      { name: "social_security" },
      { name: "national-id" },
      { name: "tax id" },
      { name: "pin" },
      { name: "email" },
      { label: "Phone number" },
      { id: "mobile" },
      { label: "Contact" },
    ];
    for (const parts of cases) {
      assert.equal(isSensitiveDescriptor(parts), true, JSON.stringify(parts));
    }
  });

  it("does not classify ordinary fields", () => {
    for (const parts of [
      { name: "q" },
      { name: "comment" },
      { placeholder: "Search the docs" },
      { label: "Hotel" },
      { name: "quantity" },
    ]) {
      assert.equal(isSensitiveDescriptor(parts), false, JSON.stringify(parts));
    }
  });
});

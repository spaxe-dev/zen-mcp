import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  EvidenceOpResult,
  EvidenceShowParams,
  SelectTabResult,
} from "../../src/shared/protocol.js";
import {
  EVIDENCE_REVEAL_HIGHLIGHT_MS,
  EvidenceRecordStore,
  EvidenceRevealError,
  cacheEvidenceRequest,
  revealEvidence,
  type EvidenceRevealDispatch,
} from "../../src/bridge/evidence-reveal.js";

const TAB = "tab-1234abcd";
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function activeSelection(): SelectTabResult {
  return {
    tab: { id: TAB, active: true } as SelectTabResult["tab"],
    activeSpaceId: "space-a",
    windowFocused: true,
  };
}

function matchedEvidence(): EvidenceOpResult {
  return {
    ok: true,
    tabId: TAB,
    url: "https://example.com/report",
    title: "Report",
    matchedQuote: "Median response time fell from 42 to 21 seconds.",
    highlighted: true,
    scrolled: true,
    verified: true,
  };
}

function recordingDispatch(
  evidence: () => EvidenceOpResult
): { dispatch: EvidenceRevealDispatch; calls: Call[] } {
  const calls: Call[] = [];
  const dispatch: EvidenceRevealDispatch = async (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> });
    if (method === "tabs.select") return activeSelection();
    return evidence();
  };
  return { dispatch, calls };
}

describe("evidence reveal store", () => {
  it("stores the agent request only when the evidence call succeeded", () => {
    const store = new EvidenceRecordStore();

    const failed = cacheEvidenceRequest(
      store,
      TAB,
      { quote: "Median response time fell." },
      {
        ok: false,
        tabId: TAB,
        url: "https://example.com/report",
        title: "Report",
        error: { code: "QUOTE_NOT_FOUND", message: "Quote not found." },
      }
    );
    assert.equal(failed, false);
    assert.equal(store.peek(TAB), undefined);

    const cached = cacheEvidenceRequest(
      store,
      TAB,
      {
        quote: "  Median response time fell.  ",
        context: " Results ",
        minConfidence: 0.9,
      },
      matchedEvidence()
    );
    assert.equal(cached, true);
    assert.deepEqual(store.peek(TAB), {
      quote: "Median response time fell.",
      context: "Results",
      minConfidence: 0.9,
    });
  });

  it("replaces the record when a tab id is reused", () => {
    const store = new EvidenceRecordStore();
    store.remember(TAB, { quote: "older passage" });
    store.remember(TAB, { quote: "newer passage" });

    assert.equal(store.size, 1);
    assert.equal(store.peek(TAB)?.quote, "newer passage");
  });

  it("evicts the oldest records beyond the bound", () => {
    const store = new EvidenceRecordStore();
    for (let index = 0; index < 21; index += 1) {
      store.remember(`tab-${String(index).padStart(8, "0")}`, {
        quote: `quote ${index}`,
      });
    }

    assert.equal(store.size, 20);
    assert.equal(store.peek("tab-00000000"), undefined);
    assert.equal(store.peek("tab-00000020")?.quote, "quote 20");

    store.clear("tab-00000020");
    assert.equal(store.peek("tab-00000020"), undefined);
  });
});

describe("evidence reveal", () => {
  it("re-highlights with scroll and a fresh TTL after the original expired", async () => {
    const store = new EvidenceRecordStore();
    // The original overlay, say 2000 ms, is long gone. The record holds no
    // TTL of its own, so the reveal still replays the request.
    store.remember(TAB, {
      quote: "Median response time fell from 42 to 21 seconds.",
      context: "Results after the six-week pilot",
      minConfidence: 0.85,
    });
    const { dispatch, calls } = recordingDispatch(matchedEvidence);
    await sleep(5);

    const result = await revealEvidence(dispatch, store, TAB);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "tabs.select");
    assert.equal(calls[0].params.tabId, TAB);
    assert.equal(calls[0].params.focusWindow, true);

    assert.equal(calls[1].method, "tabs.evidence");
    const params = calls[1].params as unknown as EvidenceShowParams;
    assert.equal(params.tabId, TAB);
    assert.equal(params.quote, "Median response time fell from 42 to 21 seconds.");
    assert.equal(params.context, "Results after the six-week pilot");
    assert.equal(params.minConfidence, 0.85);
    assert.equal(params.scroll, true);
    assert.equal(params.highlightMs, EVIDENCE_REVEAL_HIGHLIGHT_MS);

    assert.equal(result?.ok, true);
    assert.equal(result?.verified, true);
  });

  it("accepts an explicit highlight duration", async () => {
    const store = new EvidenceRecordStore();
    store.remember(TAB, { quote: "Median response time fell." });
    const { dispatch, calls } = recordingDispatch(matchedEvidence);

    await revealEvidence(dispatch, store, TAB, { highlightMs: 40_000 });

    assert.equal(calls[1].params.highlightMs, 40_000);
  });

  it("just selects the tab when no record is cached", async () => {
    const store = new EvidenceRecordStore();
    const { dispatch, calls } = recordingDispatch(matchedEvidence);

    const result = await revealEvidence(dispatch, store, TAB);

    assert.equal(result, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "tabs.select");
  });

  it("propagates a stale page as a failure and never retries another match", async () => {
    const store = new EvidenceRecordStore();
    store.remember(TAB, { quote: "Median response time fell." });
    let evidenceCalls = 0;
    const dispatch: EvidenceRevealDispatch = async (method) => {
      if (method === "tabs.select") return activeSelection();
      evidenceCalls += 1;
      return {
        ok: false,
        tabId: TAB,
        url: "https://example.com/report",
        title: "Report",
        error: {
          code: "QUOTE_NOT_FOUND",
          message: "The quote is no longer in the page.",
        },
      } satisfies EvidenceOpResult;
    };

    await assert.rejects(
      revealEvidence(dispatch, store, TAB),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceRevealError);
        assert.equal(error.code, "QUOTE_NOT_FOUND");
        assert.match(error.message, /QUOTE_NOT_FOUND/);
        assert.match(error.message, /no longer in the page/);
        return true;
      }
    );
    assert.equal(evidenceCalls, 1, "no second matcher attempt was made");
  });

  it("fails when the tab cannot be activated", async () => {
    const store = new EvidenceRecordStore();
    store.remember(TAB, { quote: "Median response time fell." });
    let evidenceCalls = 0;
    const dispatch: EvidenceRevealDispatch = async (method) => {
      if (method === "tabs.select") {
        return {
          tab: { id: TAB, active: false },
          activeSpaceId: "space-a",
        } as SelectTabResult;
      }
      evidenceCalls += 1;
      return matchedEvidence();
    };

    await assert.rejects(revealEvidence(dispatch, store, TAB), (error: unknown) => {
      assert.ok(error instanceof EvidenceRevealError);
      assert.equal(error.code, "select_failed");
      return true;
    });
    assert.equal(evidenceCalls, 0);
  });

  it("rejects an action that does not carry a tab id", async () => {
    const store = new EvidenceRecordStore();
    const { dispatch, calls } = recordingDispatch(matchedEvidence);

    await assert.rejects(
      revealEvidence(dispatch, store, "https://example.com/report"),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceRevealError);
        assert.equal(error.code, "invalid_tab");
        return true;
      }
    );
    assert.equal(calls.length, 0);
  });
});

import type {
  ActionControlBrief,
  ActionControlChange,
  PageActionDelta,
} from "./protocol.js";
import type {
  PageAlertSignature,
  PageControlSignature,
  PageHeadingSignature,
  PageSignature,
} from "./read-script.js";

export const DELTA_MAX_CONTROLS = 10;
export const DELTA_MAX_HEADINGS = 5;
export const DELTA_MAX_ALERTS = 5;

function brief(control: PageControlSignature): ActionControlBrief {
  return {
    role: control.role,
    name: control.name,
    type: control.type,
  };
}

function changedState(
  before: PageControlSignature,
  after: PageControlSignature
): string[] {
  const changes: string[] = [];
  if (before.role !== after.role) changes.push("role");
  if (before.name !== after.name) changes.push("name");
  if (before.state.visible !== after.state.visible) changes.push("visible");
  if (before.state.disabled !== after.state.disabled) changes.push("disabled");
  if (before.state.readOnly !== after.state.readOnly) changes.push("readOnly");
  if (before.state.checked !== after.state.checked) changes.push("checked");
  if (before.state.selected !== after.state.selected) changes.push("selected");
  if (before.state.valuePresent !== after.state.valuePresent) {
    changes.push("valuePresent");
  }
  return changes;
}

function textMultiset<T extends PageHeadingSignature | PageAlertSignature>(
  entries: T[] | undefined
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries ?? []) {
    if (!entry.text) continue;
    counts.set(entry.text, (counts.get(entry.text) ?? 0) + 1);
  }
  return counts;
}

function multisetDelta(
  before: Map<string, number>,
  after: Map<string, number>,
  limit: number
): { added: string[]; removed: string[] } {
  const added: string[] = [];
  for (const [text, count] of after) {
    const previous = before.get(text) ?? 0;
    for (let index = previous; index < count && added.length < limit; index += 1) {
      added.push(text);
    }
  }
  const removed: string[] = [];
  for (const [text, count] of before) {
    const next = after.get(text) ?? 0;
    for (let index = next; index < count && removed.length < limit; index += 1) {
      removed.push(text);
    }
  }
  return { added, removed };
}

export function deltaHasChanges(delta: PageActionDelta): boolean {
  return (
    delta.addedControls.length > 0 ||
    delta.removedControls.length > 0 ||
    delta.changedControls.length > 0 ||
    delta.addedHeadings.length > 0 ||
    delta.removedHeadings.length > 0 ||
    delta.addedAlerts.length > 0 ||
    delta.removedAlerts.length > 0 ||
    delta.textChanged
  );
}

/**
 * Compares two bounded page signatures. When the document was replaced, a
 * control diff would compare unrelated pages, so only the new document state
 * and an explicit limitation are reported.
 */
export function buildPageDelta(
  before: PageSignature,
  after: PageSignature,
  options: { documentReplaced: boolean }
): PageActionDelta {
  const headings = multisetDelta(
    textMultiset(before.headings),
    textMultiset(after.headings),
    DELTA_MAX_HEADINGS
  );
  const alerts = multisetDelta(
    textMultiset(before.alerts),
    textMultiset(after.alerts),
    DELTA_MAX_ALERTS
  );
  if (options.documentReplaced) {
    return {
      addedControls: [],
      removedControls: [],
      changedControls: [],
      addedHeadings: [],
      removedHeadings: [],
      addedAlerts: [],
      removedAlerts: [],
      textChanged: false,
      textLengthDelta: 0,
      readyState: after.readyState,
      limitation:
        "The document was replaced, so controls were not compared across " +
        "documents. Read the new page for a current snapshot.",
    };
  }

  const beforeControls = new Map(
    (before.controls ?? []).map((control) => [control.key, control])
  );
  const afterControls = new Map(
    (after.controls ?? []).map((control) => [control.key, control])
  );
  const addedControls: ActionControlBrief[] = [];
  for (const [key, control] of afterControls) {
    if (beforeControls.has(key)) continue;
    if (addedControls.length >= DELTA_MAX_CONTROLS) break;
    addedControls.push(brief(control));
  }
  const removedControls: ActionControlBrief[] = [];
  for (const [key, control] of beforeControls) {
    if (afterControls.has(key)) continue;
    if (removedControls.length >= DELTA_MAX_CONTROLS) break;
    removedControls.push(brief(control));
  }
  const changedControls: ActionControlChange[] = [];
  for (const [key, current] of afterControls) {
    const previous = beforeControls.get(key);
    if (!previous) continue;
    const changes = changedState(previous, current);
    if (!changes.length) continue;
    if (changedControls.length >= DELTA_MAX_CONTROLS) break;
    changedControls.push({ ...brief(current), changes });
  }

  return {
    addedControls,
    removedControls,
    changedControls,
    addedHeadings: headings.added,
    removedHeadings: headings.removed,
    addedAlerts: alerts.added,
    removedAlerts: alerts.removed,
    textChanged:
      before.textHash !== after.textHash ||
      before.textLength !== after.textLength,
    textLengthDelta: after.textLength - before.textLength,
    readyState: after.readyState,
  };
}

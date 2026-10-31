import type {
  ActivityTone,
  AnswerStatus,
  UiActivity,
  UiActivityAction,
  UiQuestion,
} from "../shared/protocol.js";

export interface QuestionAnswer {
  status: AnswerStatus;
  answer?: string;
  selectedLabels?: string[];
  freeform?: boolean;
}

export interface QuestionHandlers {
  /** Returns false when the agent connection is down; the card stays open. */
  send(answer: QuestionAnswer): boolean;
}

export interface ActivityHandlers {
  action(action: UiActivityAction): Promise<{ ok: boolean; error?: string }>;
}

interface StoredQuestion {
  element: HTMLElement;
  dismiss(): void;
}

const FALLBACK_ACCENT = "#4ec3f7";

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.sk-wrap {
  --sk-bg: var(--arrowpanel-background, var(--panel-background, var(--toolbar-bgcolor, light-dark(#fcfcfd, #1b1a20))));
  --sk-fg: var(--arrowpanel-color, var(--panel-color, var(--toolbar-color, light-dark(#15141a, #fbfbfe))));
  --sk-accent: ${FALLBACK_ACCENT};
  --sk-on-accent: #0b1218;
  --sk-border: color-mix(in srgb, var(--sk-fg) 13%, transparent);
  --sk-muted: color-mix(in srgb, var(--sk-fg) 58%, transparent);
  --sk-faint: color-mix(in srgb, var(--sk-fg) 6%, transparent);
  --sk-hover: color-mix(in srgb, var(--sk-fg) 10%, transparent);
  --sk-success: #1a7f37;
  --sk-warning: #9a6700;
  --sk-danger: #cf222e;
  --sk-shadow: 0 18px 44px rgba(0, 0, 0, .22), 0 2px 8px rgba(0, 0, 0, .12);
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  width: min(384px, calc(100vw - 28px));
  pointer-events: none;
  color: var(--sk-fg);
  color-scheme: light dark;
  font: 13px/1.45 "Segoe UI Variable Text", "SF Pro Text", system-ui, -apple-system, sans-serif;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
.sk-wrap.dark {
  --sk-success: #3fb950;
  --sk-warning: #d29922;
  --sk-danger: #ff7b72;
  --sk-shadow: 0 22px 54px rgba(0, 0, 0, .5), 0 2px 10px rgba(0, 0, 0, .3);
}
.sk-questions, .sk-activities {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  width: 100%;
  pointer-events: none;
}
.card {
  pointer-events: auto;
  width: 100%;
  border-radius: 16px;
  background: color-mix(in srgb, var(--sk-bg) 96%, transparent);
  border: 1px solid var(--sk-border);
  box-shadow: var(--sk-shadow);
  backdrop-filter: blur(22px) saturate(150%);
  padding: 13px 14px 12px;
  position: relative;
  overflow: hidden;
  animation: sk-in 210ms cubic-bezier(.2, .9, .3, 1);
  outline: none;
}
.card:focus-visible { border-color: color-mix(in srgb, var(--sk-accent) 55%, transparent); }
@keyframes sk-in {
  from { opacity: 0; transform: translateY(10px) scale(.985); }
  to { opacity: 1; transform: none; }
}
.head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 16px;
  margin-bottom: 8px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  font-weight: 650;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--sk-muted);
  white-space: nowrap;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sk-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sk-accent) 16%, transparent);
  animation: sk-pulse 2.6s ease-in-out infinite;
}
@keyframes sk-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .5; }
}
.chip {
  margin-left: auto;
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--sk-accent);
  background: color-mix(in srgb, var(--sk-accent) 13%, transparent);
  border: 1px solid color-mix(in srgb, var(--sk-accent) 22%, transparent);
  padding: 2px 6px;
  border-radius: 999px;
  white-space: nowrap;
}
.context {
  margin: 0 0 5px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--sk-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.question {
  margin: 0 0 10px;
  font-size: 14.5px;
  line-height: 1.36;
  font-weight: 600;
  letter-spacing: -.005em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.options { display: grid; gap: 6px; }
.option {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 8px 9px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: var(--sk-faint);
  color: var(--sk-fg);
  font: inherit;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease, transform .12s ease;
}
.option:hover { background: var(--sk-hover); border-color: color-mix(in srgb, var(--sk-accent) 30%, transparent); transform: translateY(-1px); }
.option:active { transform: translateY(0); }
.option:focus-visible { outline: 2px solid color-mix(in srgb, var(--sk-accent) 65%, transparent); outline-offset: 1px; }
.option[disabled] { opacity: .55; cursor: default; transform: none; }
.key {
  flex: none;
  width: 17px;
  height: 17px;
  margin-top: 0.5px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  background: color-mix(in srgb, var(--sk-accent) 15%, transparent);
  color: var(--sk-accent);
  font-size: 9.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.option-text { min-width: 0; display: block; }
.label-text { display: block; font-size: 12.5px; font-weight: 550; line-height: 1.35; overflow-wrap: anywhere; }
.desc { display: block; margin-top: 2px; font-size: 11px; color: var(--sk-muted); line-height: 1.4; overflow-wrap: anywhere; }
.option.selected {
  border-color: color-mix(in srgb, var(--sk-accent) 55%, transparent);
  background: color-mix(in srgb, var(--sk-accent) 11%, transparent);
}
.option.selected .key { background: var(--sk-accent); color: var(--sk-on-accent); }
.option.sent { border-color: color-mix(in srgb, var(--sk-accent) 70%, transparent); background: color-mix(in srgb, var(--sk-accent) 18%, transparent); }
.multi-hint { margin: 8px 0 0; font-size: 10.5px; color: var(--sk-muted); }
.freeform { display: flex; gap: 6px; margin-top: 8px; }
.freeform input {
  flex: 1;
  min-width: 0;
  background: var(--sk-faint);
  border: 1px solid var(--sk-border);
  color: var(--sk-fg);
  border-radius: 9px;
  padding: 8px 10px;
  font: inherit;
  font-size: 12px;
  outline: none;
  transition: border-color .12s ease, box-shadow .12s ease;
}
.freeform input::placeholder { color: var(--sk-muted); }
.freeform input:focus {
  border-color: color-mix(in srgb, var(--sk-accent) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sk-accent) 14%, transparent);
}
.send {
  flex: none;
  border: none;
  border-radius: 9px;
  background: var(--sk-accent);
  color: var(--sk-on-accent);
  font: inherit;
  font-size: 11.5px;
  font-weight: 650;
  padding: 0 11px;
  cursor: pointer;
}
.send[disabled] { opacity: .45; cursor: default; }
.send:focus-visible { outline: 2px solid color-mix(in srgb, var(--sk-accent) 65%, transparent); outline-offset: 2px; }
.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
}
.hint {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 10.5px;
  line-height: 1.35;
  color: var(--sk-muted);
}
.ghost {
  flex: none;
  border: none;
  background: none;
  color: var(--sk-muted);
  font: inherit;
  font-size: 11px;
  font-weight: 550;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: pointer;
}
.ghost:hover { color: var(--sk-fg); background: var(--sk-faint); }
.error {
  display: none;
  margin: 7px 0 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--sk-danger);
}
.error.on { display: block; }
.activity { padding: 11px 13px 12px; }
.activity .head { margin-bottom: 6px; }
.activity-row { display: flex; align-items: flex-start; gap: 8px; }
.tone {
  flex: none;
  width: 7px;
  height: 7px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--sk-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sk-accent) 15%, transparent);
}
.activity[data-tone="success"] .tone { background: var(--sk-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--sk-success) 16%, transparent); }
.activity[data-tone="warning"] .tone { background: var(--sk-warning); box-shadow: 0 0 0 3px color-mix(in srgb, var(--sk-warning) 16%, transparent); }
.activity-text { min-width: 0; flex: 1; }
.a-title { margin: 0; font-size: 12.5px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.a-detail { margin: 2px 0 0; font-size: 11.5px; line-height: 1.45; color: var(--sk-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.close {
  flex: none;
  margin-left: auto;
  border: none;
  background: none;
  color: var(--sk-muted);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  cursor: pointer;
}
.close:hover { color: var(--sk-fg); background: var(--sk-faint); }
.action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  padding: 5px 9px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--sk-accent) 32%, transparent);
  background: color-mix(in srgb, var(--sk-accent) 11%, transparent);
  color: var(--sk-accent);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.action:hover { background: color-mix(in srgb, var(--sk-accent) 18%, transparent); }
.action[disabled] { opacity: .6; cursor: default; }
.action-error { margin: 6px 0 0; font-size: 10.5px; color: var(--sk-danger); }
.progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 100%;
  transform-origin: left center;
  background: color-mix(in srgb, var(--sk-accent) 55%, transparent);
  animation: sk-progress var(--sk-duration, 9000ms) linear forwards;
}
@keyframes sk-progress {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}
@media (prefers-reduced-motion: reduce) {
  .card { animation: none; }
  .dot { animation: none; }
  .option { transition: none; }
  .progress { animation: none; display: none; }
}
`;

export class SidekickUi {
  readonly #doc: Document;
  readonly #host: HTMLElement;
  readonly #root: ShadowRoot;
  readonly #wrap: HTMLElement;
  readonly #questionsEl: HTMLElement;
  readonly #activitiesEl: HTMLElement;
  readonly #questions = new Map<string, StoredQuestion>();
  readonly #activities = new Map<string, { element: HTMLElement; dismiss(): void }>();

  constructor(doc: Document) {
    this.#doc = doc;
    this.#host = doc.createElement("div");
    this.#host.id = "zen-sidekick-host";
    this.#host.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    this.#root = this.#host.attachShadow({ mode: "open" });

    const style = doc.createElement("style");
    style.textContent = STYLE;

    this.#wrap = doc.createElement("div");
    this.#wrap.className = "sk-wrap";

    this.#questionsEl = doc.createElement("div");
    this.#questionsEl.className = "sk-questions";

    this.#activitiesEl = doc.createElement("div");
    this.#activitiesEl.className = "sk-activities";

    this.#wrap.append(this.#questionsEl, this.#activitiesEl);
    this.#root.append(style, this.#wrap);
    doc.documentElement.appendChild(this.#host);
  }

  get host(): HTMLElement {
    return this.#host;
  }

  #refreshTheme(): void {
    const media = this.#doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)");
    this.#wrap.classList.toggle("dark", !!media?.matches);

    // Resolve the accent through the cascade so color-mix() and theme aliases
    // both work, then pick a legible foreground for accent-filled controls.
    const probe = this.#doc.createElement("span");
    probe.style.cssText =
      "position:absolute;opacity:0;pointer-events:none;color:var(--zen-primary-color, " +
      FALLBACK_ACCENT +
      ");";
    this.#wrap.appendChild(probe);
    const accent = getComputedStyle(probe).color || FALLBACK_ACCENT;
    probe.remove();
    if (accent && accent !== "rgba(0, 0, 0, 0)") {
      this.#wrap.style.setProperty("--sk-accent", accent);
      this.#wrap.style.setProperty(
        "--sk-on-accent",
        relativeLuminance(accent) > 0.5 ? "#08131a" : "#ffffff"
      );
    }
  }

  showQuestion(question: UiQuestion, handlers: QuestionHandlers): void {
    this.#refreshTheme();
    this.cancelQuestion(question.id);

    const doc = this.#doc;
    const card = doc.createElement("article");
    card.className = "card question";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", question.question);
    card.tabIndex = 0;

    const head = doc.createElement("div");
    head.className = "head";
    const brand = doc.createElement("span");
    brand.className = "brand";
    const dot = doc.createElement("span");
    dot.className = "dot";
    brand.append(dot, doc.createTextNode("ZEN SIDEKICK"));
    const chip = doc.createElement("span");
    chip.className = "chip";
    chip.textContent = question.multiSelect ? "Choose any" : "Question";
    head.append(brand, chip);
    card.appendChild(head);

    if (question.context?.trim()) {
      const context = doc.createElement("p");
      context.className = "context";
      context.textContent = question.context.trim();
      card.appendChild(context);
    }

    const title = doc.createElement("h2");
    title.className = "question";
    title.textContent = question.question;
    card.appendChild(title);

    const error = doc.createElement("p");
    error.className = "error";
    card.appendChild(error);

    const showError = (message: string) => {
      error.textContent = message;
      error.classList.add("on");
    };
    const clearError = () => error.classList.remove("on");

    const selected = new Set<number>();
    const optionButtons: HTMLButtonElement[] = [];
    const optionsEl = doc.createElement("div");
    optionsEl.className = "options";

    const optionLabel = (index: number): string =>
      question.options[index]?.label ?? "";
    const finalAnswer = (): QuestionAnswer | null => {
      const labels = [...selected]
        .sort((a, b) => a - b)
        .map((index) => optionLabel(index))
        .filter(Boolean);
      const freeform = input?.value.trim() ?? "";
      if (!labels.length && !freeform) return null;
      const pieces = [...labels];
      if (freeform) pieces.push(freeform);
      return {
        status: "answered",
        answer: pieces.join(", "),
        selectedLabels: labels.length ? labels : undefined,
        freeform: !!freeform,
      };
    };

    let input: HTMLInputElement | null = null;
    let footerSend: HTMLButtonElement | null = null;

    const updateSendState = () => {
      if (!footerSend) return;
      const ready = selected.size > 0 || !!input?.value.trim();
      footerSend.disabled = !ready;
      if (selected.size > 0) {
        footerSend.textContent = `Send ${selected.size}`;
      } else {
        footerSend.textContent = "Send";
      }
    };

    const finish = (answer: QuestionAnswer, highlight?: HTMLElement) => {
      if (highlight) highlight.classList.add("sent");
      const sent = handlers.send(answer);
      if (!sent) {
        highlight?.classList.remove("sent");
        showError("The agent is reconnecting. Try again in a moment.");
        return;
      }
      clearError();
      this.#dismissQuestion(question.id, true);
    };

    question.options.forEach((option, index) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "option";
      button.title = `Press ${index + 1} when this card is focused`;
      const key = doc.createElement("span");
      key.className = "key";
      key.textContent = String(index + 1);
      const text = doc.createElement("span");
      text.className = "option-text";
      const label = doc.createElement("span");
      label.className = "label-text";
      label.textContent = option.label;
      text.appendChild(label);
      if (option.description) {
        const desc = doc.createElement("span");
        desc.className = "desc";
        desc.textContent = option.description;
        text.appendChild(desc);
      }
      button.append(key, text);
      button.addEventListener("click", () => {
        if (question.multiSelect) {
          if (selected.has(index)) {
            selected.delete(index);
            button.classList.remove("selected");
          } else {
            selected.add(index);
            button.classList.add("selected");
          }
          updateSendState();
          return;
        }
        const value = option.value?.trim() || option.label;
        const answer: QuestionAnswer = {
          status: "answered",
          answer: value,
          selectedLabels: [option.label],
          freeform: false,
        };
        optionButtons.forEach((other) => {
          other.disabled = other !== button;
        });
        finish(answer, button);
      });
      optionButtons.push(button);
      optionsEl.appendChild(button);
    });

    if (question.options.length) {
      card.appendChild(optionsEl);
    }

    if (question.multiSelect) {
      const hint = doc.createElement("p");
      hint.className = "multi-hint";
      hint.textContent = "Select one or more, then send.";
      card.appendChild(hint);
    }

    if (question.allowFreeform) {
      const form = doc.createElement("form");
      form.className = "freeform";
      const field = doc.createElement("input");
      field.type = "text";
      field.placeholder = question.options.length
        ? "Or type your own answer"
        : "Type your answer";
      field.setAttribute("aria-label", "Your answer");
      const send = doc.createElement("button");
      send.type = "submit";
      send.className = "send";
      send.textContent = "Send";
      send.disabled = true;
      form.append(field, send);
      input = field;
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const answer = finalAnswer();
        if (!answer) return;
        input?.blur();
        finish(answer);
      });
      field.addEventListener("input", () => {
        send.disabled = !field.value.trim();
        updateSendState();
        clearError();
      });
      card.appendChild(form);
    }

    const foot = doc.createElement("div");
    foot.className = "foot";
    const hint = doc.createElement("p");
    hint.className = "hint";
    hint.textContent = question.multiSelect
      ? "Your answer goes straight to the agent."
      : "Click an option, or ask for later.";
    const later = doc.createElement("button");
    later.type = "button";
    later.className = "ghost";
    later.textContent = "Ask me later";
    later.addEventListener("click", () => {
      finish({ status: "deferred" });
    });
    foot.append(hint);
    if (question.multiSelect) {
      footerSend = doc.createElement("button");
      footerSend.type = "button";
      footerSend.className = "send";
      footerSend.textContent = "Send";
      footerSend.disabled = true;
      footerSend.addEventListener("click", () => {
        const answer = finalAnswer();
        if (!answer) return;
        finish(answer);
      });
      foot.appendChild(footerSend);
    }
    foot.appendChild(later);
    card.appendChild(foot);

    card.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (event.key === "Escape") {
        card.blur();
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        if (index < question.options.length) {
          event.preventDefault();
          optionButtons[index]?.click();
        }
        return;
      }
      if (event.key === "Enter" && footerSend && !footerSend.disabled) {
        event.preventDefault();
        footerSend.click();
      }
    });

    this.#questionsEl.appendChild(card);
    this.#questions.set(question.id, {
      element: card,
      dismiss: () => this.#dismissQuestion(question.id, true),
    });
  }

  cancelQuestion(id: string): void {
    this.#dismissQuestion(id, false);
  }

  #dismissQuestion(id: string, animate: boolean): void {
    const stored = this.#questions.get(id);
    if (!stored) return;
    this.#questions.delete(id);
    if (!animate) {
      stored.element.remove();
      return;
    }
    stored.element
      .animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateY(6px) scale(.985)" },
        ],
        { duration: 150, easing: "ease-in" }
      )
      .finished.finally(() => stored.element.remove());
  }

  showActivity(activity: UiActivity, handlers: ActivityHandlers): void {
    this.#refreshTheme();
    const existing = this.#activities.get(activity.id);
    if (existing) {
      existing.dismiss();
      this.#activities.delete(activity.id);
    }

    while (this.#activities.size >= 3) {
      const oldestId = this.#activities.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.#activities.get(oldestId)?.dismiss();
      this.#activities.delete(oldestId);
    }

    const doc = this.#doc;
    const card = doc.createElement("article");
    card.className = "card activity";
    card.dataset.tone = normalizeTone(activity.tone);

    const head = doc.createElement("div");
    head.className = "head";
    const brand = doc.createElement("span");
    brand.className = "brand";
    const dot = doc.createElement("span");
    dot.className = "dot";
    brand.append(dot, doc.createTextNode("ZEN SIDEKICK"));
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "close";
    close.title = "Dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u00d7";
    head.append(brand, close);
    card.appendChild(head);

    const row = doc.createElement("div");
    row.className = "activity-row";
    const tone = doc.createElement("span");
    tone.className = "tone";
    const text = doc.createElement("div");
    text.className = "activity-text";
    const title = doc.createElement("p");
    title.className = "a-title";
    title.textContent = activity.title;
    text.appendChild(title);
    if (activity.detail?.trim()) {
      const detail = doc.createElement("p");
      detail.className = "a-detail";
      detail.textContent = activity.detail;
      text.appendChild(detail);
    }
    row.append(tone, text);
    card.appendChild(row);

    let actionError: HTMLElement | null = null;
    let progress: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let remaining = Math.max(0, Number(activity.autoHideMs ?? 9000));
    let startedAt = 0;
    let paused = false;
    let done = false;

    const duration = remaining > 0 ? remaining : 9000;
    if (remaining > 0) {
      progress = doc.createElement("div");
      progress.className = "progress";
      progress.style.setProperty("--sk-duration", `${duration}ms`);
      card.appendChild(progress);
    }

    const dismiss = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      timer = null;
      this.#activities.delete(activity.id);
      card
        .animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: "translateY(6px) scale(.985)" },
          ],
          { duration: 140, easing: "ease-in" }
        )
        .finished.finally(() => card.remove());
    };

    const schedule = () => {
      if (remaining <= 0 || done) return;
      startedAt = Date.now();
      timer = setTimeout(dismiss, remaining);
    };

    card.addEventListener("mouseenter", () => {
      if (done || remaining <= 0) return;
      paused = true;
      if (timer) clearTimeout(timer);
      timer = null;
      remaining -= Date.now() - startedAt;
      if (progress) progress.style.animationPlayState = "paused";
    });
    card.addEventListener("mouseleave", () => {
      if (done || remaining <= 0) return;
      paused = false;
      if (progress) progress.style.animationPlayState = "running";
      schedule();
    });
    close.addEventListener("click", dismiss);

    const actions = activity.actions ?? [];
    if (actions.length) {
      const action = actions[0];
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "action";
      button.textContent = `${action.label} \u2192`;
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        button.textContent = "Opening\u2026";
        paused = true;
        if (timer) clearTimeout(timer);
        timer = null;
        if (progress) progress.style.animationPlayState = "paused";
        actionError?.remove();
        try {
          const result = await handlers.action(action);
          if (result.ok) {
            button.textContent = "Opened";
            setTimeout(dismiss, 900);
          } else {
            paused = false;
            button.disabled = false;
            button.textContent = `${action.label} \u2192`;
            actionError = doc.createElement("p");
            actionError.className = "action-error";
            actionError.textContent = result.error || "Could not open that space.";
            card.appendChild(actionError);
            if (!paused && remaining > 0) {
              remaining = Math.min(remaining + 3000, 15000);
              schedule();
              if (progress) progress.style.animationPlayState = "running";
            }
          }
        } catch (error) {
          paused = false;
          button.disabled = false;
          button.textContent = `${action.label} \u2192`;
          actionError = doc.createElement("p");
          actionError.className = "action-error";
          actionError.textContent = String((error as Error)?.message ?? error);
          card.appendChild(actionError);
        }
      });
      card.appendChild(button);
    }

    this.#activitiesEl.appendChild(card);
    this.#activities.set(activity.id, { element: card, dismiss });
    schedule();
  }

  destroy(): void {
    for (const question of this.#questions.values()) {
      question.element.remove();
    }
    this.#questions.clear();
    for (const activity of this.#activities.values()) {
      activity.dismiss();
    }
    this.#activities.clear();
    this.#host.remove();
  }
}

function normalizeTone(tone: ActivityTone | undefined): ActivityTone {
  return tone === "success" || tone === "warning" ? tone : "info";
}

function relativeLuminance(color: string): number {
  const match = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!match) return 0;
  const [r, g, b] = match.slice(1, 4).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

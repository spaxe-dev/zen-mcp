import type {
  ActivityTone,
  AnswerStatus,
  BannerState,
  UiActivity,
  UiActivityAction,
  UiBanner,
  UiConsent,
  UiProgress,
  UiQuestion,
  UiUpdateNotice,
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

export interface ProgressHandlers {
  /**
   * Called once when the user presses Stop on a progress card. Returns false
   * when the press could not be delivered; the button is re-enabled then so
   * the user can retry instead of being left on "Stopping...".
   */
  onStop?(progressId: string): boolean | void;
  /** Returns false when the approval could not be delivered. */
  onConsent?(id: string, granted: boolean): boolean;
  /** Returns false when the pause or resume request could not be delivered. */
  onBannerAction?(action: "pause" | "resume"): boolean;
  /** Returns false when the update action could not be delivered. */
  onUpdateAction?(action: "install" | "dismiss" | "expand"): boolean;
}

interface StoredQuestion {
  element: HTMLElement;
  dismiss(): void;
}

interface ProgressView {
  id: string;
  card: HTMLElement;
  title: HTMLElement;
  step: HTMLElement;
  detail: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  stop: HTMLButtonElement;
  stopRequested: boolean;
  removed: boolean;
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
.sk-questions, .sk-progress, .sk-activities, .sk-consent-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  width: 100%;
  pointer-events: none;
}
.sk-banner {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--sk-bg) 94%, transparent);
  border: 1px solid var(--sk-border);
  box-shadow: 0 10px 26px rgba(0, 0, 0, .16);
  backdrop-filter: blur(18px) saturate(140%);
}
.sk-banner[hidden] { display: none; }
.sk-banner[data-state="pending"] {
  border-color: color-mix(in srgb, var(--sk-warning) 48%, transparent);
}
.sk-banner[data-state="paused"] {
  border-color: color-mix(in srgb, var(--sk-danger) 52%, transparent);
  background: color-mix(in srgb, var(--sk-danger) 10%, var(--sk-bg));
}
.banner-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sk-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sk-success) 16%, transparent);
}
.sk-banner[data-state="pending"] .banner-dot {
  background: var(--sk-warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sk-warning) 16%, transparent);
  animation: sk-pulse 2.6s ease-in-out infinite;
}
.sk-banner[data-state="paused"] .banner-dot {
  background: var(--sk-danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sk-danger) 16%, transparent);
}
.banner-text { flex: 1; min-width: 0; }
.banner-title {
  margin: 0;
  font-size: 11.5px;
  font-weight: 650;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.banner-detail {
  margin: 1px 0 0;
  font-size: 10.5px;
  line-height: 1.35;
  color: var(--sk-muted);
  overflow-wrap: anywhere;
}
.banner-button,
.update-apply {
  flex: none;
  padding: 5px 9px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--sk-fg) 18%, transparent);
  background: var(--sk-faint);
  color: var(--sk-fg);
  font: inherit;
  font-size: 10.5px;
  font-weight: 650;
  cursor: pointer;
  white-space: nowrap;
}
.banner-button:hover,
.update-apply:hover { background: var(--sk-hover); }
.banner-button:focus-visible,
.update-apply:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--sk-accent) 65%, transparent);
  outline-offset: 1px;
}
.sk-banner[data-state="paused"] .banner-button {
  border-color: color-mix(in srgb, var(--sk-success) 42%, transparent);
  background: color-mix(in srgb, var(--sk-success) 12%, transparent);
  color: var(--sk-success);
}
.banner-update,
.banner-update-prompt {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.banner-update[hidden],
.banner-update-icon[hidden],
.banner-update-prompt[hidden],
.banner-dismiss[hidden],
.update-apply[hidden] { display: none; }
.banner-update-icon {
  width: 20px;
  height: 20px;
  padding: 0;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: var(--sk-faint);
  color: var(--sk-accent);
  cursor: pointer;
}
.banner-update-icon:hover { background: var(--sk-hover); }
.banner-update-icon:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--sk-accent) 65%, transparent);
  outline-offset: 1px;
}
.banner-update-icon svg { width: 12px; height: 12px; display: block; }
.update-label {
  max-width: 112px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--sk-accent);
  overflow-wrap: anywhere;
}
.update-label.muted { color: var(--sk-muted); font-weight: 550; }
.banner-dismiss {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--sk-muted);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.banner-dismiss:hover { color: var(--sk-fg); background: var(--sk-faint); }
.banner-dismiss:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--sk-accent) 65%, transparent);
  outline-offset: 1px;
}
.consent { padding: 14px 15px 13px; }
.consent-title {
  margin: 0 0 6px;
  font-size: 14.5px;
  line-height: 1.35;
  font-weight: 650;
  letter-spacing: -.005em;
  overflow-wrap: anywhere;
}
.consent-detail {
  margin: 0 0 12px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--sk-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.consent-actions { display: flex; align-items: center; gap: 8px; }
.consent-allow {
  border: none;
  border-radius: 9px;
  background: var(--sk-accent);
  color: var(--sk-on-accent);
  font: inherit;
  font-size: 11.5px;
  font-weight: 650;
  padding: 7px 12px;
  cursor: pointer;
}
.consent-allow:hover { filter: brightness(1.05); }
.consent-allow:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--sk-accent) 65%, transparent);
  outline-offset: 2px;
}
.consent-deny {
  border: none;
  background: none;
  color: var(--sk-muted);
  font: inherit;
  font-size: 11.5px;
  font-weight: 550;
  padding: 7px 6px;
  border-radius: 7px;
  cursor: pointer;
}
.consent-deny:hover { color: var(--sk-fg); background: var(--sk-faint); }
.consent-hint {
  margin: 9px 0 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--sk-muted);
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
.progress-card { --sk-tone: var(--sk-accent); }
.progress-card[data-tone="success"] { --sk-tone: var(--sk-success); }
.progress-card[data-tone="warning"] { --sk-tone: var(--sk-warning); }
.progress-card .dot {
  background: var(--sk-tone);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sk-tone) 16%, transparent);
}
.progress-row { display: flex; align-items: flex-start; gap: 10px; }
.progress-body { flex: 1; min-width: 0; }
.progress-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.progress-step {
  margin: 2px 0 0;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--sk-fg);
  overflow-wrap: anywhere;
}
.progress-detail {
  margin: 2px 0 0;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--sk-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.progress-bar {
  margin-top: 9px;
  height: 4px;
  width: 100%;
  border-radius: 999px;
  background: var(--sk-faint);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  width: 0%;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--sk-tone) 55%, transparent),
    var(--sk-tone)
  );
  transition: width .3s ease;
}
.stop-button {
  flex: none;
  align-self: center;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--sk-danger) 38%, transparent);
  background: color-mix(in srgb, var(--sk-danger) 11%, transparent);
  color: var(--sk-danger);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.stop-button:hover:not([disabled]) { background: color-mix(in srgb, var(--sk-danger) 18%, transparent); }
.stop-button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--sk-danger) 55%, transparent);
  outline-offset: 1px;
}
.stop-button[disabled] { opacity: .6; cursor: default; }
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
  .progress-fill { transition: none; }
}
`;

export class ZenMcpUi {
  readonly #doc: Document;
  readonly #host: HTMLElement;
  readonly #root: ShadowRoot;
  readonly #wrap: HTMLElement;
  readonly #bannerEl: HTMLElement;
  readonly #bannerTitle: HTMLElement;
  readonly #bannerDetail: HTMLElement;
  readonly #bannerButton: HTMLButtonElement;
  readonly #bannerUpdate: HTMLElement;
  readonly #updateIcon: HTMLButtonElement;
  readonly #updatePrompt: HTMLElement;
  readonly #updateLabel: HTMLElement;
  readonly #updateApply: HTMLButtonElement;
  readonly #updateDismiss: HTMLButtonElement;
  readonly #consentEl: HTMLElement;
  readonly #questionsEl: HTMLElement;
  readonly #progressEl: HTMLElement;
  readonly #activitiesEl: HTMLElement;
  readonly #questions = new Map<string, StoredQuestion>();
  readonly #activities = new Map<string, { element: HTMLElement; dismiss(): void }>();
  readonly #handlers: ProgressHandlers;
  #progressView: ProgressView | null = null;
  #consentView: { id: string; element: HTMLElement } | null = null;
  #bannerState: "pending" | "active" | "paused" = "active";

  constructor(doc: Document, handlers: ProgressHandlers = {}) {
    this.#doc = doc;
    this.#handlers = handlers;
    this.#host = doc.createElement("div");
    this.#host.id = "zen-mcp-host";
    this.#host.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    this.#root = this.#host.attachShadow({ mode: "open" });

    const style = doc.createElement("style");
    style.textContent = STYLE;

    this.#wrap = doc.createElement("div");
    this.#wrap.className = "sk-wrap";

    this.#bannerEl = doc.createElement("div");
    this.#bannerEl.className = "sk-banner";
    this.#bannerEl.hidden = true;
    this.#bannerEl.dataset.state = "active";
    this.#bannerEl.setAttribute("role", "status");
    this.#bannerEl.setAttribute("aria-live", "polite");
    const bannerDot = doc.createElement("span");
    bannerDot.className = "banner-dot";
    const bannerText = doc.createElement("div");
    bannerText.className = "banner-text";
    this.#bannerTitle = doc.createElement("p");
    this.#bannerTitle.className = "banner-title";
    this.#bannerDetail = doc.createElement("p");
    this.#bannerDetail.className = "banner-detail";
    this.#bannerDetail.hidden = true;
    bannerText.append(this.#bannerTitle, this.#bannerDetail);
    this.#bannerButton = doc.createElement("button");
    this.#bannerButton.type = "button";
    this.#bannerButton.className = "banner-button";
    this.#bannerButton.textContent = "Pause";
    this.#bannerButton.addEventListener("click", () => {
      const action = this.#bannerState === "paused" ? "resume" : "pause";
      this.#handlers.onBannerAction?.(action);
    });

    this.#bannerUpdate = doc.createElement("span");
    this.#bannerUpdate.className = "banner-update";
    this.#bannerUpdate.hidden = true;
    this.#updateIcon = doc.createElement("button");
    this.#updateIcon.type = "button";
    this.#updateIcon.className = "banner-update-icon";
    this.#updateIcon.title = "Update available";
    this.#updateIcon.setAttribute("aria-label", "Update available");
    this.#updateIcon.appendChild(createDownloadIcon(doc));
    this.#updateIcon.addEventListener("click", () => {
      this.#handlers.onUpdateAction?.("expand");
    });
    this.#updatePrompt = doc.createElement("span");
    this.#updatePrompt.className = "banner-update-prompt";
    this.#updatePrompt.hidden = true;
    this.#updatePrompt.setAttribute("role", "group");
    this.#updatePrompt.setAttribute("aria-label", "Zen MCP update available");
    this.#updateLabel = doc.createElement("span");
    this.#updateLabel.className = "update-label";
    this.#updateApply = doc.createElement("button");
    this.#updateApply.type = "button";
    this.#updateApply.className = "update-apply";
    this.#updateApply.textContent = "Update";
    this.#updateApply.setAttribute("aria-label", "Install the update");
    this.#updateApply.addEventListener("click", () => {
      this.#handlers.onUpdateAction?.("install");
    });
    this.#updateDismiss = doc.createElement("button");
    this.#updateDismiss.type = "button";
    this.#updateDismiss.className = "banner-dismiss";
    this.#updateDismiss.textContent = "\u00d7";
    this.#updateDismiss.title = "Dismiss";
    this.#updateDismiss.setAttribute("aria-label", "Dismiss update notice");
    this.#updateDismiss.addEventListener("click", () => {
      this.#handlers.onUpdateAction?.("dismiss");
    });
    this.#updatePrompt.append(
      this.#updateLabel,
      this.#updateApply,
      this.#updateDismiss
    );
    this.#bannerUpdate.append(this.#updateIcon, this.#updatePrompt);
    this.#bannerEl.append(
      bannerDot,
      bannerText,
      this.#bannerUpdate,
      this.#bannerButton
    );

    this.#consentEl = doc.createElement("div");
    this.#consentEl.className = "sk-consent-stack";

    this.#questionsEl = doc.createElement("div");
    this.#questionsEl.className = "sk-questions";

    this.#progressEl = doc.createElement("div");
    this.#progressEl.className = "sk-progress";

    this.#activitiesEl = doc.createElement("div");
    this.#activitiesEl.className = "sk-activities";

    this.#wrap.append(
      this.#bannerEl,
      this.#consentEl,
      this.#questionsEl,
      this.#progressEl,
      this.#activitiesEl
    );
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

  /** Shows, updates or (with null) hides the persistent agent banner. */
  showBanner(banner: UiBanner | null): void {
    if (!banner) {
      this.#bannerEl.hidden = true;
      return;
    }
    this.#refreshTheme();
    this.#bannerState = banner.state;
    this.#bannerEl.dataset.state = banner.state;
    this.#bannerEl.hidden = false;
    this.#bannerTitle.textContent = banner.text;
    setOptionalText(this.#bannerDetail, banner.detail);
    this.#renderUpdate(banner.update, banner.state);
    this.#bannerButton.hidden = banner.state === "pending";
    this.#bannerButton.textContent =
      banner.state === "paused" ? "Resume" : "Pause";
    this.#bannerButton.setAttribute(
      "aria-label",
      banner.state === "paused" ? "Resume agent access" : "Pause agent access"
    );
  }

  #renderUpdate(
    update: UiUpdateNotice | null | undefined,
    state: BannerState
  ): void {
    const notice = update ?? null;
    // The consent and paused messages must stay unambiguous; the update is
    // only offered while agent access is active.
    const visible = !!notice && state === "active";
    this.#bannerUpdate.hidden = !visible;
    if (!notice || !visible) return;

    const version = `v${notice.latestVersion}`;
    this.#updateIcon.hidden = notice.state !== "icon";
    this.#updateIcon.title = `Update ${version} available`;
    this.#updateIcon.setAttribute(
      "aria-label",
      `Update ${version} available. Installed version ${notice.currentVersion}.`
    );

    this.#updatePrompt.hidden = notice.state === "icon";
    if (notice.state === "icon") return;

    this.#updateLabel.classList.remove("muted");
    this.#updateLabel.title = "";
    this.#updateApply.hidden = true;
    this.#updateDismiss.hidden = false;

    switch (notice.state) {
      case "installing":
        this.#updateLabel.textContent = `Updating to ${version}\u2026`;
        this.#updateDismiss.hidden = true;
        return;
      case "installed":
        this.#updateLabel.textContent = "Updated. Restart client.";
        this.#updateLabel.title = `Zen MCP ${notice.latestVersion} is installed. Restart the MCP client to load it.`;
        this.#updateLabel.classList.add("muted");
        return;
      case "failed":
        this.#updateLabel.textContent = "Update failed";
        this.#updateLabel.title =
          notice.message ?? "Run `zen-mcp update` in a terminal.";
        this.#updateApply.hidden = false;
        this.#updateApply.textContent = "Retry";
        this.#updateApply.setAttribute(
          "aria-label",
          `Retry installing Zen MCP ${version}`
        );
        return;
      default:
        this.#updateLabel.textContent = version;
        this.#updateLabel.title = `Installed version ${notice.currentVersion}`;
        this.#updateApply.hidden = false;
        this.#updateApply.textContent = "Update";
        this.#updateApply.setAttribute(
          "aria-label",
          `Install Zen MCP ${version}`
        );
        return;
    }
  }

  showConsent(consent: UiConsent): void {
    this.#refreshTheme();
    this.cancelConsent();

    const doc = this.#doc;
    const card = doc.createElement("article");
    card.className = "card consent";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", consent.title);

    const head = doc.createElement("div");
    head.className = "head";
    const brand = doc.createElement("span");
    brand.className = "brand";
    const dot = doc.createElement("span");
    dot.className = "dot";
    brand.append(dot, doc.createTextNode("ZEN MCP"));
    const chip = doc.createElement("span");
    chip.className = "chip";
    chip.textContent = "Permission";
    head.append(brand, chip);
    card.appendChild(head);

    const title = doc.createElement("h2");
    title.className = "consent-title";
    title.textContent = consent.title;
    card.appendChild(title);

    const detail = doc.createElement("p");
    detail.className = "consent-detail";
    detail.textContent = consent.detail;
    card.appendChild(detail);

    const actions = doc.createElement("div");
    actions.className = "consent-actions";
    const deny = doc.createElement("button");
    deny.type = "button";
    deny.className = "consent-deny deny";
    deny.textContent = consent.denyLabel;
    const allow = doc.createElement("button");
    allow.type = "button";
    allow.className = "consent-allow allow";
    allow.textContent = consent.allowLabel;
    actions.append(allow, deny);
    card.appendChild(actions);

    const hint = doc.createElement("p");
    hint.className = "consent-hint";
    hint.textContent =
      "Only this MCP session gets access. Zen MCP closes the Marionette port " +
      "and never attaches to a browser it did not start.";
    card.appendChild(hint);

    const finish = (granted: boolean) => {
      const delivered = this.#handlers.onConsent?.(consent.id, granted);
      if (delivered === false) return;
      this.cancelConsent(consent.id);
    };
    allow.addEventListener("click", () => finish(true));
    deny.addEventListener("click", () => finish(false));

    this.#consentEl.appendChild(card);
    this.#consentView = { id: consent.id, element: card };
  }

  cancelConsent(id?: string): void {
    const view = this.#consentView;
    if (!view) return;
    if (id && view.id !== id) return;
    this.#consentView = null;
    view.element.remove();
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
    brand.append(dot, doc.createTextNode("ZEN MCP"));
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

  /**
   * Create, update or (with null) hide the persistent progress card.
   * Repeated updates mutate the existing nodes, so nothing leaks and keyboard
   * focus inside the card survives. Focus is never taken unless it was
   * already inside the card.
   */
  showProgress(progress: UiProgress | null): void {
    if (!progress) {
      this.#hideProgress();
      return;
    }
    this.#refreshTheme();

    const current = this.#progressView;
    if (current && current.id === progress.id) {
      this.#updateProgress(current, progress);
      return;
    }

    // document.activeElement only reports the shadow host, so look inside.
    const active = this.#root.activeElement;
    const restoreFocus = !!current && !!active && current.card.contains(active);
    if (current) this.#removeProgress(current, true);
    this.#createProgress(progress, restoreFocus);
  }

  #createProgress(progress: UiProgress, restoreFocus: boolean): void {
    const doc = this.#doc;
    const card = doc.createElement("article");
    card.className = "card progress-card";
    card.dataset.tone = normalizeTone(progress.tone);

    const head = doc.createElement("div");
    head.className = "head";
    const brand = doc.createElement("span");
    brand.className = "brand";
    const dot = doc.createElement("span");
    dot.className = "dot";
    brand.append(dot, doc.createTextNode("ZEN MCP"));
    head.appendChild(brand);
    card.appendChild(head);

    const row = doc.createElement("div");
    row.className = "progress-row";
    const body = doc.createElement("div");
    body.className = "progress-body";
    const title = doc.createElement("p");
    title.className = "progress-title";
    const step = doc.createElement("p");
    step.className = "progress-step";
    step.hidden = true;
    const detail = doc.createElement("p");
    detail.className = "progress-detail";
    detail.hidden = true;
    const bar = doc.createElement("div");
    bar.className = "progress-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.hidden = true;
    const fill = doc.createElement("div");
    fill.className = "progress-fill";
    bar.appendChild(fill);
    body.append(title, step, detail, bar);

    const stop = doc.createElement("button");
    stop.type = "button";
    stop.className = "stop-button";
    stop.textContent = "Stop";

    row.append(body, stop);
    card.appendChild(row);
    this.#progressEl.appendChild(card);

    const view: ProgressView = {
      id: progress.id,
      card,
      title,
      step,
      detail,
      bar,
      fill,
      stop,
      stopRequested: false,
      removed: false,
    };
    this.#progressView = view;

    stop.addEventListener("click", () => {
      if (view.removed || view.stop.disabled) return;
      view.stopRequested = true;
      view.stop.disabled = true;
      view.stop.textContent = "Stopping\u2026";
      let delivered = true;
      try {
        delivered = this.#handlers.onStop?.(view.id) !== false;
      } catch {
        delivered = false;
      }
      if (delivered || view.removed) return;
      // The press never reached the host. Let the user try again instead of
      // leaving the card permanently on "Stopping...".
      view.stopRequested = false;
      view.stop.disabled = false;
      view.stop.textContent = "Retry stop";
    });

    this.#updateProgress(view, progress);

    if (restoreFocus && !stop.hidden && !stop.disabled) {
      stop.focus({ preventScroll: true });
    }
  }

  #updateProgress(view: ProgressView, progress: UiProgress): void {
    view.card.dataset.tone = normalizeTone(progress.tone);
    view.title.textContent = progress.title;
    setOptionalText(view.step, progress.step);
    setOptionalText(view.detail, progress.detail);

    const ratio =
      typeof progress.progress === "number" && Number.isFinite(progress.progress)
        ? Math.min(1, Math.max(0, progress.progress))
        : null;
    if (ratio === null) {
      view.bar.hidden = true;
      view.bar.removeAttribute("aria-valuenow");
      view.fill.style.width = "0%";
    } else {
      const percent = Math.round(ratio * 100);
      view.bar.hidden = false;
      view.bar.setAttribute("aria-valuenow", String(percent));
      view.fill.style.width = `${percent}%`;
    }

    if (progress.stopRequested) view.stopRequested = true;
    const stopping = view.stopRequested;
    view.stop.hidden = !progress.stoppable;
    view.stop.disabled = stopping;
    view.stop.textContent = stopping ? "Stopping\u2026" : "Stop";
  }

  #hideProgress(): void {
    const view = this.#progressView;
    if (view) this.#removeProgress(view, true);
  }

  #removeProgress(view: ProgressView, animate: boolean): void {
    if (view.removed) return;
    view.removed = true;
    if (this.#progressView === view) this.#progressView = null;
    if (!animate) {
      view.card.remove();
      return;
    }
    view.card
      .animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateY(6px) scale(.985)" },
        ],
        { duration: 150, easing: "ease-in" }
      )
      .finished.finally(() => view.card.remove());
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
    brand.append(dot, doc.createTextNode("ZEN MCP"));
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
        button.textContent = "Working\u2026";
        paused = true;
        if (timer) clearTimeout(timer);
        timer = null;
        if (progress) progress.style.animationPlayState = "paused";
        actionError?.remove();
        try {
          const result = await handlers.action(action);
          if (result.ok) {
            button.textContent = "Done";
            setTimeout(dismiss, 900);
          } else {
            paused = false;
            button.disabled = false;
            button.textContent = `${action.label} \u2192`;
            actionError = doc.createElement("p");
            actionError.className = "action-error";
            actionError.textContent =
              result.error || "That action could not be completed.";
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
    this.cancelConsent();
    this.#bannerEl.remove();
    for (const question of this.#questions.values()) {
      question.element.remove();
    }
    this.#questions.clear();
    const progress = this.#progressView;
    if (progress) this.#removeProgress(progress, false);
    for (const activity of this.#activities.values()) {
      activity.dismiss();
    }
    this.#activities.clear();
    this.#host.remove();
  }
}

function setOptionalText(element: HTMLElement, value: string | undefined): void {
  const text = value?.trim() ?? "";
  element.textContent = text;
  element.hidden = !text;
}

function normalizeTone(tone: ActivityTone | undefined): ActivityTone {
  return tone === "success" || tone === "warning" ? tone : "info";
}

function createDownloadIcon(doc: Document): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS(ns, "path");
  path.setAttribute("d", "M8 2.5v7m0 0 2.75-2.75M8 9.5 5.25 6.75M3 12.5h10");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
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

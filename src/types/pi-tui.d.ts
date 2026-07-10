/**
 * Type declarations for @earendil-works/pi-tui — a client-only optional
 * dep for `abtars tui` (#1315). The runtime installs this lazily via
 * `abtars deps install tui`; the local declaration is what TypeScript
 * uses to typecheck. Pin to the same ~0.80 range as OPTIONAL_DEPS.tui.
 *
 * Only the surface the client uses is declared — minimal API.
 */

declare module "@earendil-works/pi-tui" {
  // ── Terminal ───────────────────────────────────────────────────────
  export interface Terminal {
    start(onInput: (data: string) => void, onResize: () => void): void;
    stop(): void;
    write(data: string): void;
    get columns(): number;
    get rows(): number;
    hideCursor(): void;
    showCursor(): void;
  }
  export class ProcessTerminal implements Terminal {
    constructor();
    start(onInput: (data: string) => void, onResize: () => void): void;
    stop(): void;
    write(data: string): void;
    hideCursor(): void;
    showCursor(): void;
    get columns(): number;
    get rows(): number;
  }

  // ── TUI / Container ────────────────────────────────────────────────
  export interface Component {
    /* marker */
  }
  export interface Focusable extends Component {
    focused: boolean;
  }
  export type InputListenerResult = { consume?: boolean; data?: string } | undefined;
  export type InputListener = (data: string) => InputListenerResult;
  export class Container implements Component {
    addChild(component: Component): void;
  }
  export class TUI extends Container {
    constructor(terminal: Terminal, showHardwareCursor?: boolean);
    setFocus(component: Component | null): void;
    addInputListener(listener: InputListener): () => void;
    requestRender(force?: boolean): void;
    start(): void;
    stop(): void;
  }

  // ── Editor ─────────────────────────────────────────────────────────
  export interface SelectListTheme {
    itemName: (s: string) => string;
    itemDescription: (s: string) => string;
    noItems: (s: string) => string;
    scrollInfo: (s: string) => string;
    selectedPrefix: (s: string) => string;
    selectedText: (s: string) => string;
    description: (s: string) => string;
    hint: (s: string) => string;
  }
  export interface EditorTheme {
    borderColor: (s: string) => string;
    selectList: SelectListTheme;
  }
  export interface EditorOptions {
    paddingX?: number;
    autocompleteMaxVisible?: number;
  }
  export class Editor implements Component, Focusable {
    focused: boolean;
    constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions);
    onSubmit?: (text: string) => void;
  }

  // ── Markdown / Text ────────────────────────────────────────────────
  export interface DefaultTextStyle {
    color?: (text: string) => string;
    bgColor?: (text: string) => string;
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
  }
  // Pinned to pi-tui 0.80.6 — every key Markdown.render() may invoke is
  // declared explicitly. Drop the previous open index signature so a
  // missing required method (e.g. forgetting `bold` or `listBullet`)
  // surfaces at typecheck time instead of crashing the TUI at runtime.
  export interface MarkdownTheme {
    heading: (text: string) => string;
    link: (text: string) => string;
    linkUrl: (text: string) => string;
    code: (text: string) => string;
    codeBlock: (text: string) => string;
    codeBlockBorder: (text: string) => string;
    quote: (text: string) => string;
    quoteBorder: (text: string) => string;
    hr: (text: string) => string;
    listBullet: (text: string) => string;
    bold: (text: string) => string;
    italic: (text: string) => string;
    strikethrough: (text: string) => string;
    underline: (text: string) => string;
    highlightCode?: (code: string, lang?: string) => string[];
    codeBlockIndent?: string;
  }
  export interface MarkdownOptions {
    preserveOrderedListMarkers?: boolean;
    preserveBackslashEscapes?: boolean;
  }
  export class Markdown implements Component {
    constructor(
      text: string,
      paddingX: number,
      paddingY: number,
      theme: MarkdownTheme,
      defaultTextStyle?: DefaultTextStyle,
      options?: MarkdownOptions,
    );
  }
  export class Text implements Component {
    constructor(text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string);
  }

  // ── Key matching ───────────────────────────────────────────────────
  export type KeyId = string;
  export function matchesKey(data: string, keyId: KeyId): boolean;
}

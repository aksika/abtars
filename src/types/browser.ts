/** Actions the browser tool supports. */
export type BrowserActionType =
  | "navigate"
  | "click"
  | "fill"
  | "extract_text"
  | "screenshot"
  | "get_page_info"
  | "close_session";

/** Parsed browser tool action from CLI args. */
export type BrowserAction = {
  action: BrowserActionType;
  sessionId: string;       // default: "default"
  url?: string;            // for navigate
  selector?: string;       // for click, fill, extract_text
  value?: string;          // for fill
  fullPage?: boolean;      // for screenshot
};

/** Result returned by the browser tool (JSON to stdout). */
export type BrowserToolResult = {
  success: boolean;
  error?: string;
  // navigate
  title?: string;
  url?: string;
  status?: number;
  // click
  navigated?: boolean;
  // extract_text
  text?: string;
  truncated?: boolean;
  // screenshot
  filePath?: string;
  // get_page_info
  elements?: PageElement[];
};

/** An interactive element on the page (for get_page_info). */
export type PageElement = {
  tag: string;             // "a", "button", "input", etc.
  selector: string;        // CSS selector to target this element
  text?: string;           // visible text content
  type?: string;           // input type (for form elements)
  name?: string;           // input name attribute
  placeholder?: string;    // input placeholder
  href?: string;           // link href (for anchors)
};

/** Internal session state tracked by BrowserManager. */
export type BrowserSession = {
  sessionId: string;
  context: import("patchright").BrowserContext;
  page: import("patchright").Page;
  createdAt: number;
  lastActivityAt: number;
};

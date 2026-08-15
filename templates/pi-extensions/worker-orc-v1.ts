/**
 * worker-orc-v1.ts — #1643: supervised Worker communication tools.
 *
 * Protocol v1 contract, loaded only for durable supervised Pi runs (see
 * src/components/pi-executor/worker-orc-extension.ts). Runs inside Pi's
 * extension loader: it must stay self-contained on Pi's public extension API
 * and never import abtars modules, access the network, the filesystem, or
 * process state.
 *
 * tell_orc: reports one consequential finding to Orc and lets the Worker
 *   continue. The HOST recognizes the tool from the typed
 *   tool_execution_start frame and posts the durable channel message; the
 *   tool result itself performs no side effect.
 * ask_orc: emits an ordinary extension_ui_request(method=input) with no
 *   extension-owned timeout. The supervised host closes the process through
 *   the existing input-suspension lifecycle after receiving the request; a
 *   Pi-owned timer would race that settlement.
 */
import { Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROTOCOL = 1;

function boundedString(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > maxLength ? "" : text;
}

export default function workerOrcExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "tell_orc",
    label: "Tell Orc",
    description: "Report one consequential finding to Orc and continue working.",
    promptSnippet: "tell_orc(message): notify Orc of a consequential finding without waiting",
    promptGuidelines: [
      "Use tell_orc only when Orc should know a consequential finding while you can continue.",
      "tell_orc is not a question and does not produce an answer.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    async execute(_toolCallId, { message }) {
      const body = boundedString(message, 1000);
      if (!body) {
        return {
          content: [{ type: "text", text: "Error: message must contain non-whitespace text within 1000 characters." }],
          details: { protocol: PROTOCOL, kind: "tell_orc", submitted: false },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: "Notification submitted to Orc; continue working." }],
        details: { protocol: PROTOCOL, kind: "tell_orc", submitted: true, characters: body.length },
      };
    },
  });

  pi.registerTool({
    name: "ask_orc",
    label: "Ask Orc",
    description: "Stop safely and ask Orc one concrete blocking question.",
    promptSnippet: "ask_orc(question): suspend safely when one Orc answer is required",
    promptGuidelines: [
      "Use ask_orc only when blocked on one concrete answer.",
      "Asking suspends this attempt; do not use it for optional status updates.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
    async execute(_toolCallId, { question }, _signal, _onUpdate, ctx) {
      const body = boundedString(question, 4000);
      if (!body) {
        return {
          content: [{ type: "text", text: "Error: question must contain non-whitespace text within 4000 characters." }],
          details: { protocol: PROTOCOL, kind: "ask_orc", submitted: false },
          isError: true,
        };
      }
      // No timeout is deliberate: the supervised host settles the run through
      // the input-suspension lifecycle upon receiving this request. The
      // post-await result is unreachable under supervision but keeps the
      // extension contract valid in an unexpected interactive host.
      await ctx.ui.input("Ask Orc", body);
      return {
        content: [{ type: "text", text: "Orc answered; continue with the answer above." }],
        details: { protocol: PROTOCOL, kind: "ask_orc" },
      };
    },
  });
}

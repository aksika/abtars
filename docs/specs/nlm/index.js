import { execSync } from "node:child_process";

const NLM_DEFAULT = "/Users/akos/.local/bin/nlm";
const CDP_URL = "http://127.0.0.1:18800";

function nlm(args, nlmPath, profile) {
  const profileFlag = profile && profile !== "default" ? ` --profile ${profile}` : "";
  const cmd = `${nlmPath} ${args}${profileFlag} --json 2>&1`;
  try {
    return execSync(cmd, { timeout: 60_000, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH + ":/Users/akos/.local/bin" } }).trim();
  } catch (e) {
    const out = e.stdout?.trim() || e.stderr?.trim() || e.message;
    // Auto-refresh on auth failure
    if (/auth.*expired|401|403|login/i.test(out)) {
      try {
        execSync(`${nlmPath} login --provider openclaw --cdp-url ${CDP_URL} 2>&1`, { timeout: 30_000, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH + ":/Users/akos/.local/bin" } });
        return execSync(cmd, { timeout: 60_000, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH + ":/Users/akos/.local/bin" } }).trim();
      } catch (e2) {
        return e2.stdout?.trim() || e2.message;
      }
    }
    return out;
  }
}

function txt(s) { return { content: [{ type: "text", text: s }] }; }

export default function (api) {
  const cfg = api.pluginConfig || {};
  const nlmPath = cfg.nlmPath || NLM_DEFAULT;
  const profile = cfg.profile || "default";

  api.registerTool({
    name: "nlm_query",
    description: "Query a NotebookLM notebook (RAG). Use this to search the Layer 6 knowledge base for curated reference material, documents, and research.",
    parameters: {
      type: "object",
      properties: {
        notebook: { type: "string", description: "Notebook ID or alias" },
        question: { type: "string", description: "Question to ask the notebook" },
      },
      required: ["notebook", "question"],
    },
    async execute(_id, params) {
      return txt(nlm(`notebook query ${params.notebook} "${params.question.replace(/"/g, '\\"')}"`, nlmPath, profile));
    },
  });

  api.registerTool({
    name: "nlm_notebooks",
    description: "List all NotebookLM notebooks.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      return txt(nlm("notebook list", nlmPath, profile));
    },
  });

  api.registerTool({
    name: "nlm_sources",
    description: "List sources in a NotebookLM notebook.",
    parameters: {
      type: "object",
      properties: {
        notebook: { type: "string", description: "Notebook ID or alias" },
      },
      required: ["notebook"],
    },
    async execute(_id, params) {
      return txt(nlm(`source list ${params.notebook}`, nlmPath, profile));
    },
  });

  api.registerTool({
    name: "nlm_source_add",
    description: "Add a source to a NotebookLM notebook. Supports URL, text, or file.",
    parameters: {
      type: "object",
      properties: {
        notebook: { type: "string", description: "Notebook ID or alias" },
        url: { type: "string", description: "URL to add as source" },
        text: { type: "string", description: "Text content to add as source" },
        title: { type: "string", description: "Title for text source" },
        file: { type: "string", description: "File path to upload" },
      },
      required: ["notebook"],
    },
    async execute(_id, params) {
      let args = `source add ${params.notebook}`;
      if (params.url) args += ` --url "${params.url}"`;
      else if (params.text) args += ` --text "${params.text.replace(/"/g, '\\"')}" --title "${(params.title || "Note").replace(/"/g, '\\"')}"`;
      else if (params.file) args += ` --file "${params.file}"`;
      else return txt("Provide url, text, or file.");
      args += " --wait";
      return txt(nlm(args, nlmPath, profile));
    },
  });

  api.registerTool({
    name: "nlm_notebook_create",
    description: "Create a new NotebookLM notebook.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notebook title" },
      },
      required: ["title"],
    },
    async execute(_id, params) {
      return txt(nlm(`notebook create "${params.title.replace(/"/g, '\\"')}"`, nlmPath, profile));
    },
  });

  api.registerTool({
    name: "nlm_reauth",
    description: "Refresh NotebookLM authentication via OpenClaw browser CDP. Use when nlm tools return auth errors.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      try {
        const out = execSync(`${nlmPath} login --provider openclaw --cdp-url ${CDP_URL} 2>&1`, { timeout: 30_000, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH + ":/Users/akos/.local/bin" } });
        return txt(out.trim());
      } catch (e) {
        return txt(`Reauth failed: ${e.stdout?.trim() || e.message}`);
      }
    },
  });
}

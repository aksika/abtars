# Convex for A2A Agent Communication — Study

Study date: 2026-03-14
Sources: docs.convex.dev, convex.dev/plans, GitHub get-convex/convex-backend

## 1. What Is Convex

A reactive backend-as-a-service built around a document-relational database. All server logic is written in TypeScript — queries, mutations, and actions — deployed to Convex's runtime. The database is ACID-compliant with serializable isolation. No SQL, no ORMs.

Key properties:
- **Reactive**: queries auto-rerun when underlying data changes; clients get WebSocket push updates
- **TypeScript-native**: schema, functions, client — all TS with end-to-end type safety
- **Document-relational**: JSON-like documents in tables, with typed IDs for cross-table references
- **Open source**: Rust backend on GitHub, self-hostable via Docker + Postgres/SQLite
- **Managed or self-hosted**: free cloud tier or run your own

## 2. Core Concepts

### Function Types

| Type | Purpose | DB Access | Side Effects | Deterministic |
|------|---------|-----------|-------------|---------------|
| **Query** | Read data | Read-only | None | Yes |
| **Mutation** | Write data | Read + Write | None | Yes (transaction) |
| **Action** | External calls | Via mutation/query calls | Yes (HTTP, LLM, etc.) | No |

Queries and mutations run inside the database with transactional guarantees. Actions run in a Node.js environment and can call external APIs, then write results back via mutations.

### Schema Definition

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    sender: v.string(),       // agent ID
    recipient: v.string(),    // agent ID
    content: v.string(),      // message body
    status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("processed")),
    metadata: v.optional(v.any()),
  })
    .index("by_recipient_status", ["recipient", "status"])
    .index("by_sender", ["sender"]),
});
```

### Server Functions

```typescript
// convex/messages.ts
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Send a message (mutation = transaction)
export const send = mutation({
  args: {
    sender: v.string(),
    recipient: v.string(),
    content: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      ...args,
      status: "pending",
    });
  },
});

// Get pending messages for an agent (query = reactive)
export const getPending = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_recipient_status", (q) =>
        q.eq("recipient", agentId).eq("status", "pending")
      )
      .collect();
  },
});

// Mark message as processed (mutation)
export const markProcessed = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    await ctx.db.patch(messageId, { status: "processed" });
  },
});
```

### Node.js Client (Server-Side)

Two client types for non-browser environments:

```typescript
// ConvexHttpClient — stateless, request/response (for scripts, serverless)
import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex/_generated/api";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);
const messages = await client.query(api.messages.getPending, { agentId: "professor" });
await client.mutation(api.messages.send, { sender: "hermes", recipient: "professor", content: "hello" });

// ConvexClient — WebSocket, reactive subscriptions (for long-running processes)
import { ConvexClient } from "convex/browser";

const client = new ConvexClient(process.env.CONVEX_URL!);
client.onUpdate(api.messages.getPending, { agentId: "professor" }, (messages) => {
  // Called automatically whenever new messages arrive
  for (const msg of messages) {
    processMessage(msg);
  }
});
```

## 3. Why Convex for A2A

### Current A2A Architecture (AgentBridge)

```
Agent A (Hermes) --HTTP POST--> Agent B (Professor/AgentBridge)
                                  agent-api-server.ts:3001
                                  scanPrompt() → ensureAgentTransport() → kiro-cli
                                  HTTP 200 response (sync, blocks until done)
```

Problems:
- **Synchronous**: caller blocks until kiro-cli finishes (can be minutes)
- **Point-to-point**: agents must know each other's IP:port
- **Fire-and-forget**: no persistence, no retry, no audit trail
- **No discovery**: hardcoded `AGENT_API_ALLOWED_IPS`

### Convex A2A Architecture (Proposed Addition)

```
Agent A (Hermes)                    Convex DB                     Agent B (Professor)
     |                                 |                                |
     |-- mutation: send() ------------>|                                |
     |                                 |-- WebSocket push: getPending ->|
     |                                 |                                |-- process message
     |                                 |<-- mutation: markProcessed() --|
     |                                 |                                |
     |<- query: getResponse() ---------|                                |
```

Benefits:
- **Async by default**: sender writes and moves on; recipient picks up when ready
- **Persistent**: every message is a DB record with status tracking
- **Reactive**: WebSocket subscription means instant delivery (sub-50ms)
- **Decoupled**: agents only need the Convex URL, not each other's addresses
- **Audit trail**: full message history queryable
- **Multi-agent**: any number of agents can read/write to the same tables
- **Transactional**: mutations are ACID — no partial writes, no race conditions

### What It Replaces vs Complements

This would be **additive** — the current HTTP A2A stays for direct, low-latency, same-network calls. Convex adds:
- Cross-network agent communication (agents on different machines/networks)
- Async task queuing (long-running tasks that shouldn't block the caller)
- Message persistence and status tracking
- Multi-agent broadcast/fan-out patterns

## 4. Integration Design for AgentBridge

### Minimal Schema

```typescript
// convex/schema.ts
export default defineSchema({
  a2a_messages: defineTable({
    sender: v.string(),           // "hermes", "professor", etc.
    recipient: v.string(),        // target agent ID
    content: v.string(),          // the prompt/message
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("rejected"),      // prompt injection blocked
    ),
    response: v.optional(v.string()),
    error: v.optional(v.string()),
    metadata: v.optional(v.any()),  // extra context, scan results, etc.
  })
    .index("by_recipient_status", ["recipient", "status"])
    .index("by_sender", ["sender"]),
});
```

### AgentBridge Integration Points

```
src/components/
  convex-a2a-client.ts    # NEW — Convex client wrapper
  agent-api-server.ts     # EXISTING — keep HTTP A2A, add Convex polling option
```

Minimal client concept:

```typescript
// src/components/convex-a2a-client.ts
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

export class ConvexA2AClient {
  private client: ConvexClient;
  private agentId: string;

  constructor(convexUrl: string, agentId: string) {
    this.client = new ConvexClient(convexUrl);
    this.agentId = agentId;
  }

  /** Subscribe to incoming messages */
  startListening(handler: (messages: any[]) => void): void {
    this.client.onUpdate(
      anyApi.a2a_messages.getPending,
      { agentId: this.agentId },
      handler,
    );
  }

  /** Send a message to another agent */
  async send(recipient: string, content: string): Promise<string> {
    return this.client.mutation(anyApi.a2a_messages.send, {
      sender: this.agentId,
      recipient,
      content,
    });
  }

  /** Mark message as processed with response */
  async complete(messageId: string, response: string): Promise<void> {
    await this.client.mutation(anyApi.a2a_messages.complete, {
      messageId,
      response,
    });
  }

  close(): void {
    this.client.close();
  }
}
```

### Config Addition

```env
# ~/.agentbridge/.env
CONVEX_URL=https://your-deployment.convex.cloud   # or self-hosted URL
CONVEX_AGENT_ID=professor                          # this agent's identity
CONVEX_A2A_ENABLED=false                           # opt-in
```

## 5. Convex Agent Component

Convex has a first-party `@convex-dev/agents` component specifically for AI agent workflows. It provides:

- **Threads**: persistent conversation threads shared across agents and users
- **Messages**: auto-persisted message history with built-in context management
- **Streaming**: real-time token streaming to clients
- **Tools**: agent tool definitions with type-safe arguments
- **RAG**: built-in hybrid vector/text search for message context
- **Workflows**: durable multi-step operations spanning agents
- **Rate limiting**: per-user/per-agent rate controls
- **Usage tracking**: token/cost tracking per agent

```typescript
import { Agent } from "@convex-dev/agents";
import { openai } from "@ai-sdk/openai";

const supportAgent = new Agent(components.agent, {
  name: "Support Agent",
  chat: openai.chat("gpt-4o-mini"),
  instructions: "You are a helpful assistant.",
  tools: { accountLookup, fileTicket },
});

// Create a thread, generate response
const { threadId, thread } = await supportAgent.createThread(ctx);
const result = await thread.generateText({ prompt: "Help me with X" });

// Continue later (same or different agent)
const { thread: t2 } = await anotherAgent.continueThread(ctx, { threadId });
const result2 = await t2.generateText({ prompt: "Follow up on X" });
```

This is interesting but **not what we need for A2A messaging**. Our agents don't share a Convex deployment — they're independent processes. The Agent component is for building agents *within* Convex. We'd use the raw database + functions for inter-agent messaging.

## 6. Pricing (Free Tier)

| Resource | Free Tier | Notes |
|----------|-----------|-------|
| Function calls | 1,000,000/month | Queries + mutations + actions |
| Action compute | 20 GB-hours/month | Node.js action runtime |
| Database storage | 0.5 GB | Total across all tables |
| Database bandwidth | 1 GB/month | Read + write |
| File storage | 1 GB | For file uploads |
| Vector storage | 0.5 GB | For vector search |
| Tables | 10,000 | Per deployment |
| Deployments | 40 | Per account |
| Concurrency | 16 queries/mutations, 64 actions | Simultaneous |

For our A2A use case: 1M function calls/month is massive — even at 1000 messages/day that's only 90K calls/month (send + getPending + markProcessed per message). 0.5 GB storage holds millions of small text messages. **Free tier is more than sufficient.**

Starter plan (pay-as-you-go beyond free): $2.20/M function calls, $0.22/GB storage.

## 7. Self-Hosting Option

Convex backend is open source (FSL Apache 2.0 → converts to full Apache 2.0 after 2 years). Self-hosting via Docker + Postgres:

```bash
git clone https://github.com/get-convex/convex-backend
cd convex-backend/self-hosted
# Follow README for Docker Compose setup
```

Self-hosting gives:
- Full control over data location
- No usage limits (only your hardware)
- Same codebase as cloud service
- Requires managing infrastructure (Postgres, the Convex runtime)

For our use case: **cloud free tier first**, self-host later if needed.

## 8. Comparison: Convex vs Alternatives for A2A

| Aspect | Convex | Redis Pub/Sub | NATS | PostgreSQL + LISTEN/NOTIFY | Current HTTP |
|--------|--------|--------------|------|---------------------------|-------------|
| Persistence | ✅ Built-in | ❌ Volatile | ⚠️ JetStream | ✅ Tables | ❌ None |
| Real-time | ✅ WebSocket reactive | ✅ Pub/Sub | ✅ Pub/Sub | ⚠️ NOTIFY | ❌ Polling |
| TypeScript-native | ✅ End-to-end | ❌ Client only | ❌ Client only | ❌ SQL | ✅ |
| Schema validation | ✅ Runtime + types | ❌ None | ❌ None | ✅ SQL types | ❌ None |
| Managed hosting | ✅ Free tier | ⚠️ Paid (Upstash) | ⚠️ Paid (Synadia) | ⚠️ Paid (Neon, Supabase) | N/A (local) |
| Self-hostable | ✅ Docker | ✅ | ✅ | ✅ | N/A |
| Transactional | ✅ Serializable | ❌ | ❌ | ✅ | N/A |
| Setup complexity | Low (npm + deploy) | Low | Medium | Medium | Already done |
| Agent framework | ✅ @convex-dev/agents | ❌ | ❌ | ❌ | ❌ |

Convex wins on: TypeScript alignment (matches our stack), persistence + reactivity combo, free tier generosity, and the fact that it's a single dependency that gives us DB + real-time + serverless functions.

## 9. Risks & Considerations

- **External dependency**: adds a cloud service dependency (mitigated by self-host option)
- **Latency**: cloud Convex adds network hop vs localhost HTTP (~50ms vs ~1ms)
- **Complexity**: another system to understand and maintain
- **Vendor lock-in**: schema/functions are Convex-specific (mitigated by open source)
- **WSL networking**: WebSocket from WSL to Convex cloud should work fine (outbound only)

## 10. Implementation Roadmap

### Phase 1: Prototype (additive, no changes to existing A2A)
1. `npm install convex` in agentbridge
2. Create `convex/` directory with schema + functions for A2A messaging
3. Deploy to Convex cloud (free tier)
4. Build `ConvexA2AClient` wrapper
5. Wire into `main.ts` as optional listener alongside existing HTTP A2A

### Phase 2: Integration
6. Prompt scanning on Convex messages (reuse `scanPrompt()`)
7. Response writing back to Convex (agent completes task → mutation)
8. Status dashboard integration (Convex queries for message history)

### Phase 3: Advanced
9. Multi-agent routing (message bus pattern)
10. Convex-side serverless functions for message preprocessing
11. Consider self-hosting if usage grows

## 11. Quick Start Commands

```bash
# Install
npm install convex

# Initialize (creates convex/ directory)
npx convex init

# Deploy functions to cloud
npx convex deploy

# Dev mode (auto-redeploy on changes)
npx convex dev
```

## 12. Verdict

Convex is a strong fit for **async, persistent A2A messaging** alongside our existing HTTP A2A. The TypeScript-native approach matches our stack perfectly. Free tier covers our volume easily. The reactive WebSocket subscriptions give us real-time message delivery without polling.

Recommended approach: **keep HTTP A2A for direct low-latency calls, add Convex as an async message bus for cross-network and queued communication.** Start with cloud free tier, prototype with a simple send/receive/complete flow.

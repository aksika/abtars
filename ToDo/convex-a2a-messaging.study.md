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

## 7. Scheduling & Cron Jobs

Convex has built-in durable scheduling — relevant for A2A retry logic, message cleanup, and deferred task execution.

### Scheduled Functions

Schedule any function to run after a delay or at a specific time. Stored in the database, survives restarts.

```typescript
// Schedule a retry in 30 seconds if processing fails
export const retryMessage = mutation({
  args: { messageId: v.id("a2a_messages") },
  handler: async (ctx, { messageId }) => {
    const msg = await ctx.db.get(messageId);
    if (msg?.status === "failed") {
      await ctx.db.patch(messageId, { status: "pending" });
      // Or schedule a more complex retry action
      await ctx.scheduler.runAfter(30000, internal.a2a.processMessage, { messageId });
    }
  },
});
```

Key details:
- `ctx.scheduler.runAfter(delayMs, fn, args)` — run after delay
- `ctx.scheduler.runAt(timestamp, fn, args)` — run at specific time
- Scheduling from mutations is atomic with the transaction (if mutation fails, nothing is scheduled)
- Scheduling from actions is NOT atomic (scheduled function runs even if action later fails)
- `runAfter(0, ...)` = add to queue immediately (like `setTimeout(fn, 0)`)
- Mutations are retried automatically on internal errors (exactly-once); actions are at-most-once
- Can cancel via `ctx.scheduler.cancel(scheduledFnId)`
- Status queryable via `_scheduled_functions` system table (Pending → InProgress → Success/Failed/Canceled)
- Results retained for 7 days after completion
- Limit: 1000 scheduled functions per single function call, 8MB total argument size

### Cron Jobs

Recurring schedules defined in `convex/crons.ts`:

```typescript
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Clean up completed messages older than 7 days
crons.interval("cleanup old messages", { hours: 6 }, internal.a2a.cleanupOldMessages);

// Health check: flag stale "processing" messages
crons.interval("stale message check", { minutes: 5 }, internal.a2a.checkStaleMessages);

export default crons;
```

Schedule types:
- `crons.interval()` — every N seconds/minutes/hours (seconds-level granularity)
- `crons.cron()` — standard crontab syntax (`"0 16 1 * *"`)
- `crons.hourly()`, `crons.daily()`, `crons.weekly()`, `crons.monthly()` — named convenience methods
- At most one run of each cron executes at a time; if previous run is still going, next is skipped

### A2A Relevance

For our use case, scheduling enables:
- **Retry failed messages**: schedule a retry mutation after N seconds on failure
- **Message TTL**: cron job to clean up old completed/failed messages
- **Stale detection**: cron to flag messages stuck in "processing" too long
- **Deferred delivery**: schedule a message to be delivered at a future time

## 8. Self-Hosting Option

Convex backend is open source (FSL Apache 2.0 → converts to full Apache 2.0 after 2 years). Three services to deploy: backend, dashboard, and your frontend app.

### Quick Start (Docker)

```bash
# Download docker-compose.yml from get-convex/convex-backend/self-hosted/docker/
docker compose up

# Generate admin key for dashboard/CLI
docker compose exec backend ./generate_admin_key.sh
```

Default ports:
- Backend API: `http://127.0.0.1:3210`
- HTTP actions: `http://127.0.0.1:3211`
- Dashboard: `http://localhost:6791`

### Project Configuration

```env
# .env.local in your Convex project (NOT committed to source control)
CONVEX_SELF_HOSTED_URL='http://127.0.0.1:3210'
CONVEX_SELF_HOSTED_ADMIN_KEY='<your admin key>'
```

Then use the CLI normally: `npx convex dev`, `npx convex deploy`, etc.

### Storage Options

- **Default**: SQLite (local, zero config, good for dev/small deployments)
- **Production**: Postgres or MySQL (external, scalable)
- **File storage**: can use S3 for exports, snapshots, modules, files, and search indexes
- Docker volume for persistent state (or cloud equivalent like AWS EBS)

### Advanced Hosting Options

Documented guides exist for:
- Fly.io deployment
- Railway.com deployment
- Hosting on your own servers (bare metal / VMs)
- Running the binary directly (no Docker)
- Postgres/MySQL database backend
- S3 storage integration
- Dashboard customization
- Version upgrades
- Benchmarking and performance tuning (knobs)

### Limitations

Self-hosted supports all free-tier features. Cloud-hosted is optimized for scale.

### For Our Use Case

**Cloud free tier first** — zero ops, generous limits. Self-host later if:
- We need data locality (all data on our infrastructure)
- Usage exceeds free tier (unlikely for A2A messaging volume)
- We want zero external dependencies for air-gapped setups

## 9. Comparison: Convex vs Alternatives for A2A

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

## 10. Risks & Considerations

- **External dependency**: adds a cloud service dependency (mitigated by self-host option)
- **Latency**: cloud Convex adds network hop vs localhost HTTP (~50ms vs ~1ms)
- **Complexity**: another system to understand and maintain
- **Vendor lock-in**: schema/functions are Convex-specific (mitigated by open source)
- **WSL networking**: WebSocket from WSL to Convex cloud should work fine (outbound only)

## 11. Implementation Roadmap

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

## 12. Quick Start Commands

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

## 13. Verdict

Convex is a strong fit for **async, persistent A2A messaging** alongside our existing HTTP A2A. The TypeScript-native approach matches our stack perfectly. Free tier covers our volume easily. The reactive WebSocket subscriptions give us real-time message delivery without polling.

Recommended approach: **keep HTTP A2A for direct low-latency calls, add Convex as an async message bus for cross-network and queued communication.** Start with cloud free tier, prototype with a simple send/receive/complete flow.

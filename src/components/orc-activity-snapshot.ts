import type { ManagedSession } from "./spin-types.js";
import { type KanbanCard, kanbanGetCard, resolveRootId, resolveActiveDescendants, resolveRecentDirectChildren } from "./tasks/kanban-board.js";

const TAG = "orc-snapshot";

export interface ActivityCard {
  id: number;
  title: string;
  status: string;
  priority: string;
  type: string | null;
  parentId: number | null;
  tokensUsed: number | null;
}

export interface OrcActivitySnapshot {
  sessionId: string;
  executionId?: string;
  busy: boolean;
  sequence: number;
  root?: ActivityCard;
  activeChildren: ActivityCard[];
  recentDirectChildren: ActivityCard[];
}

function toActivityCard(card: KanbanCard): ActivityCard {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    priority: card.priority,
    type: card.type,
    parentId: card.parent_id,
    tokensUsed: card.tokens_used,
  };
}

/**
 * #1319: Build a snapshot of the current Orc execution state.
 * Returns a safe partial snapshot on any error — never throws.
 */
export function buildOrcActivitySnapshot(
  orcSession: ManagedSession,
  allSessions: Map<string, ManagedSession>,
  currentSequence: number,
): OrcActivitySnapshot {
  const base: OrcActivitySnapshot = {
    sessionId: orcSession.id,
    executionId: orcSession.activeExecutionId,
    busy: orcSession.busy,
    sequence: currentSequence,
    activeChildren: [],
    recentDirectChildren: [],
  };

  try {
    const rootCardId = orcSession.activeRootCardId;
    if (rootCardId === undefined) return base;

    const rootCard = kanbanGetCard(rootCardId);
    if (!rootCard) return { ...base, root: { id: rootCardId, title: "(unknown)", status: "unknown", priority: "", type: null, parentId: null, tokensUsed: null } };

    base.root = toActivityCard(rootCard);
    base.activeChildren = resolveActiveDescendants(rootCardId).map(toActivityCard);
    base.recentDirectChildren = resolveRecentDirectChildren(rootCardId).map(toActivityCard);
    return base;
  } catch (err) {
    return base;
  }
}

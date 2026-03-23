/**
 * Determine the routing destination for a reaction signal.
 * Returns "transport" for private chats, "buffer" for group/supergroup chats,
 * or "discard" if the user is not authorized.
 */
export type ReactionRouteResult = "transport" | "buffer" | "discard";

export function routeReaction(
  isAuthorized: boolean,
  chatType: string,
): ReactionRouteResult {
  if (!isAuthorized) return "discard";
  if (chatType === "group" || chatType === "supergroup") return "buffer";
  return "transport";
}

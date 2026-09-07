/**
 * Maximum model-facing Pi tool-result text, including any truncation
 * announcement. This is a character bound, not a transport or storage limit.
 *
 * Anchored to bash-runner's MAX_BUFFER_BYTES (1 MiB), the largest payload any
 * tool in the registry can produce. At this size the bound never shortens a
 * legitimate result — it exists only to stop an unbounded future tool, and it
 * announces rather than silently cuts when it does fire. Deliberately NOT tuned
 * to the review-brief budget; see specs/1772/requirements.md R2.5.
 */
export const PI_CORE_TOOL_RESULT_MAX_CHARS = 1_048_576;

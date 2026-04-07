# Hippocampus Memory System — Deep Research

**Paper:** "Hippocampus: An Efficient and Scalable Memory Module for Agentic AI" (2026)
**ArXiv:** https://arxiv.org/abs/2602.13594

## What it is

A memory system that replaces dense vector databases (embeddings) with two compressed data structures:

1. **Content DWM** — lossless token-ID sequences for exact content reconstruction
2. **Signature DWM** — compact binary signatures for semantic search

Both stored in a Dynamic Wavelet Matrix (DWM) — a succinct data structure that supports search directly in the compressed domain.

## Core innovation: no embeddings needed

Traditional memory systems: text → embedding model → float32 vector → vector DB → cosine similarity search.

Hippocampus: text → token IDs + binary signature → DWM → Hamming distance search.

The binary signature is generated via **Random Indexing** (a form of Locality-Sensitive Hashing):
- Project each token's vector against random hyperplanes
- Produces a compact binary hash (e.g., 256 bits)
- Semantically similar texts have similar signatures (small Hamming distance)
- Search = count bit differences, not compute cosine similarity over float arrays

## Performance claims

- **31× faster** end-to-end retrieval vs vector DB systems
- **14× lower** per-query token footprint
- Maintains accuracy on LoCoMo and LongMemEval benchmarks
- Scales linearly with memory size (vs quadratic for dense vectors)

## Architecture

### Memory Construction Pipeline
```
Raw text (dialogue turn)
  ├── Content serialization → token-ID sequence → Content DWM
  └── Metadata extraction + Random Indexing → binary signature → Signature DWM
```

### Memory Query Pipeline
```
Query text → binary signature via Random Indexing
  → Hamming-ball search on Signature DWM (find similar signatures)
  → Retrieve matching content from Content DWM (exact reconstruction)
  → Return to LLM
```

### Dynamic Wavelet Matrix (DWM)

Extension of the wavelet matrix — a succinct data structure for:
- Space-efficient storage (compressed)
- Fast rank/select operations (search in compressed domain)
- Dynamic updates (supports streaming writes — new memories added without rebuilding)

The "dynamic" part is key for agentic use: memories are added continuously during conversation, not batch-indexed.

## Benchmark results (LoCoMo)

| System | Single-Hop F1 | Multi-Hop F1 | Temporal F1 | Open-Domain F1 |
|---|---|---|---|---|
| ReadAgent | 8.78 | 5.44 | 11.24 | 9.32 |
| MemoryBank | 5.05 | 6.02 | 9.85 | 7.90 |
| MemGPT (Letta) | 25.43 | 9.11 | 26.48 | 39.74 |
| A-mem | 19.82 | 12.97 | 34.63 | — |
| **Hippocampus** | **best or competitive across all** | | | |

(Full numbers in paper Table 1 and Table 2)

## What's relevant for ABM

### Binary signatures as embedding alternative

**The idea:** Instead of storing 384-dim float32 embeddings (1536 bytes each via ollama), store 256-bit binary signatures (32 bytes each). 48× smaller. Search via Hamming distance instead of cosine similarity — pure bitwise operations, no floating point math.

**For ABM:**
- Our `embedding BLOB` column stores ollama float32 vectors (~1.5KB per memory)
- Binary signatures would be ~32 bytes per memory
- Search: XOR + popcount (CPU instruction) vs dot product over 384 floats
- Could be our embedding-free search mode for mobile/edge profiles

**Trade-off:** Binary signatures are approximate. Cosine similarity on dense vectors is more precise. But for recall (where we return top-10 and the LLM picks what's relevant), approximate is fine.

### Random Indexing implementation

```typescript
// Simplified: generate binary signature from text
function randomIndex(tokens: number[], hyperplanes: Float32Array[]): Uint8Array {
  const signature = new Uint8Array(32); // 256 bits
  for (let bit = 0; bit < 256; bit++) {
    let sum = 0;
    for (const token of tokens) {
      sum += hyperplanes[bit]![token % hyperplanes[bit]!.length]!;
    }
    if (sum > 0) signature[bit >> 3]! |= (1 << (bit & 7));
  }
  return signature;
}

// Search: Hamming distance
function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = a[i]! ^ b[i]!;
    while (xor) { dist++; xor &= xor - 1; } // popcount
  }
  return dist;
}
```

~20 lines of code. No external dependency. No ollama. Works on any device.

### Lossless token-ID storage

**The idea:** Instead of storing text as UTF-8 strings, store as token IDs (integers). The DWM compresses these efficiently because token IDs have patterns (common words = low IDs, repeated often).

**For ABM:** Less relevant. Our three-tier storage (Original → English → ABM-L) already handles compression. Token-ID storage would add complexity without clear benefit since we already have ABM-L as the compressed form.

### Dynamic updates (streaming writes)

**The idea:** The DWM supports adding new entries without rebuilding the entire index. Critical for agentic use where memories are added during conversation.

**For ABM:** Our SQLite + FTS5 already supports this. INSERT triggers update FTS5 incrementally. Not a gap for us.

## What we should borrow

| Concept | Borrow? | Why |
|---|---|---|
| Binary signatures for search | ✅ Yes | 48× smaller than float32 embeddings, works without ollama |
| Hamming distance search | ✅ Yes | Pure bitwise, ~20 lines, no dependency |
| Random Indexing | ✅ Yes | Generates signatures without embedding model |
| Dynamic Wavelet Matrix | ❌ No | Complex data structure, our SQLite indexes are sufficient |
| Token-ID storage | ❌ No | ABM-L is our compressed form, simpler |
| Lossless reconstruction | ❌ No | We keep content_en for exact reconstruction |

## Integration with ABM

### New column: `signature BLOB` (32 bytes per memory)

Generated at store time alongside ABM-L compression:
```
instant-store → content_en + emotion_tags + importance_flags + content_compressed (ABM-L) + signature (binary)
```

### Search pipeline with signatures

```
Query → generate query signature (Random Indexing, ~0.1ms)
  → scan all signatures, compute Hamming distance (~1ms for 10K memories)
  → top-N candidates by Hamming distance
  → if embeddings available: rerank with cosine similarity (precision boost)
  → if no embeddings: return as-is (good enough for recall)
```

### Hybrid: signatures + embeddings

On desktop (ollama available): signatures as fast pre-filter → embeddings for precision rerank.
On mobile/edge (no ollama): signatures only. Still good recall quality.

This replaces our planned "embedding-free search" with something better — binary signatures give semantic similarity, not just keyword matching.

## Storage comparison

| Representation | Size per memory | Search method | Quality |
|---|---|---|---|
| Float32 embedding (384-dim) | 1,536 bytes | Cosine similarity | Best |
| Binary signature (256-bit) | 32 bytes | Hamming distance | Good (approximate) |
| ABM-L text | ~50 bytes | Keyword match | Decent |
| No index | 0 bytes | Full scan | Slow |

For 10,000 memories:
- Embeddings: 15 MB
- Signatures: 320 KB (48× smaller)
- Both: 15.3 MB (signatures add negligible overhead)

## References

- Paper: https://arxiv.org/abs/2602.13594
- Random Indexing: Kanerva et al. (2000)
- Wavelet Matrix: Gog and Petri (2014)
- Locality-Sensitive Hashing: Indyk and Motwani (1998)

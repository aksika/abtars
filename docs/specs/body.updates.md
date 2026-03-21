# Body (Infrastructure) — Update Journal

## 2026-03-20: Deploy safe_cp for agent-modified skills

**Problem:** `deploy.sh` used raw `cp` for all steering/skill files. If the agent modified a deployed skill in-place (e.g. refined curation rules), the next deploy would silently overwrite it.

**Solution:**
- `safe_cp()` helper: compares timestamps, skips if deployed file is newer than source, prints `⏭ KEPT newer: filename.md`.
- All steering, skill, and prompt deploys now use `safe_cp`.

**Files changed:** `scripts/deploy.sh`

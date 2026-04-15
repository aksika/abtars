# #144 Dashboard Redesign

**Date:** 2026-04-15
**Status:** Planned
**Priority:** MEDIUM

## Goal

Clean up dashboard layout. Remove lower panel. Three overlay panels (same pattern as Memory Universe). Auth status indicators for external services.

## Changes

### 1. Auth status indicators on main dashboard

Green/red dots for authenticated services:

| Service | Check | Source |
|---|---|---|
| Gmail (gws) | `gwsAuth` | Already in StatusSnapshot |
| NotebookLM | `notebooklm.enabled` | Already in StatusSnapshot |
| X.com | `xAuth` | New — check if `~/.agentbridge/secret/cookies/x-cookies.json` exists |

Add `xAuth: boolean` to StatusSnapshot + `buildStatusSnapshot()`.

### 2. Memory Search → overlay panel

Move existing search UI from lower panel into a full-screen overlay (same style as Memory Universe). Toggle via button on main dashboard.

### 3. Live Log → overlay panel

Move bridge.log tail into a full-screen overlay. +2px font size for log text (this panel only). Toggle via button on main dashboard.

### 4. Remove lower panel

Main dashboard becomes: status cards + auth indicators + 3 launch buttons.

### 5. Three launch buttons

| Button | Opens |
|---|---|
| 🌌 Memory Universe | 3D memory visualization (existing) |
| 🔍 Memory Search | Search UI overlay (new) |
| 📋 Live Log | Log viewer overlay (new) |

## Implementation

| Step | What | Time |
|---|---|---|
| 1 | Add `xAuth` to StatusSnapshot + buildStatusSnapshot | 10 min |
| 2 | Auth status indicators (Gmail, NLM, X.com) on main dashboard | 15 min |
| 3 | Extract Memory Search into overlay panel | 20 min |
| 4 | Extract Live Log into overlay panel, +2px font | 15 min |
| 5 | Remove lower panel | 5 min |
| 6 | Add 3 launch buttons | 10 min |
| 7 | Test | 10 min |
| **Total** | | **~1.25 hr** |

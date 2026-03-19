---
alwaysApply: true
---

# PowerPoint Creation via MCP

Create .pptx files using `mcporter call pptx.<tool>` commands. The MCP server runs locally via daemon (no data leaves the machine).

## Prerequisites
- Daemon must be running: `mcporter daemon status` (if not: `mcporter daemon start`)
- Every call after `create_presentation` must include `presentation_id="<id>"`

## Workflow

```bash
# 1. Create
mcporter call pptx.create_presentation
# Returns: {"presentation_id": "presentation_1", ...}

# 2. Add slides (pass presentation_id from step 1)
mcporter call pptx.add_slide title="Title Here" presentation_id="presentation_1"
# Returns: {"slide_index": 0, ...}

# 3. Add content to slides (use slide_index from step 2)
mcporter call pptx.manage_text slide_index=0 operation="add" text="Content" presentation_id="presentation_1"
mcporter call pptx.add_bullet_points slide_index=0 placeholder_idx=1 bullet_points='["Point 1","Point 2"]' presentation_id="presentation_1"

# 4. Save
mcporter call pptx.save_presentation file_path="/path/to/output.pptx" presentation_id="presentation_1"
```

## Key Tools (most used)

| Tool | Purpose | Required params |
|------|---------|-----------------|
| `create_presentation` | New blank pptx | — |
| `add_slide` | Add slide | `title`, `presentation_id` |
| `manage_text` | Add/format text | `slide_index`, `operation` ("add"), `text` |
| `add_bullet_points` | Bullet list | `slide_index`, `placeholder_idx`, `bullet_points` (JSON array) |
| `add_table` | Data table | `slide_index`, `rows`, `cols`, `left`, `top`, `width`, `height`, `data` |
| `add_chart` | Chart | `slide_index`, `chart_type`, position, `categories`, `series_names`, `series_values` |
| `manage_image` | Insert image | `slide_index`, `operation` ("add"), `image_source` |
| `add_shape` | Shape | `slide_index`, `shape_type`, position+size |
| `apply_professional_design` | Theme/styling | `operation` ("apply_theme"), `color_scheme` |
| `save_presentation` | Save to disk | `file_path`, `presentation_id` |
| `auto_generate_presentation` | Quick full pptx | `topic`, `slide_count` |

## Shortcut: auto_generate_presentation

For quick presentations, use the auto-generator:
```bash
mcporter call pptx.auto_generate_presentation topic="Q4 Financial Results" slide_count=8 color_scheme="corporate_gray" presentation_id="presentation_1"
```

## Color Schemes
`modern_blue`, `corporate_gray`, `elegant_green`, `warm_red`

## Positioning
All positions in inches. Slide is 13.33" × 7.5" (widescreen 16:9).

## Output Path Convention
Save to: `~/.agentbridge/output/pptx/<filename>.pptx`

## Array/Object Parameters
Pass JSON arrays as single-quoted strings:
```bash
bullet_points='["Item 1","Item 2","Item 3"]'
data='[["Header1","Header2"],["val1","val2"]]'
series_values='[[10,20,30],[15,25,35]]'
```

## Full tool list
Run `mcporter list pptx --schema` for complete documentation of all 32 tools.

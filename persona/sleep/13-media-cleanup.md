# §9.5 Media Cleanup

Check `~/.agentbridge/received/` total size:
```bash
du -sb ~/.agentbridge/received/ 2>/dev/null | awk '{print $1}'
```

If total > 100MB (104857600 bytes), delete oldest files first (FIFO by modification time) until under 100MB:
```bash
find ~/.agentbridge/received/ -type f -printf '%T@ %p\n' | sort -n | head -20
```

For any images in `received/media/` received today and not yet described:
- Read the image and generate a brief description
- Store via `agentbridge-store --translated "Photo: <description>" --original "Photo: <description>" --memory-type fact --emotion-score 0 --chat-id 7773842843`

Respond with: files deleted count, bytes freed, images described.

# Voice (STT/TTS)

Telegram supports voice transcription and synthesized voice replies.

## Speech-to-text

Transcription uses Groq Whisper. Store the GROQ_API_KEY credential in abTARS's local secret directory. Speech-to-text enables by default when that credential is present; STT_ENABLED can explicitly enable or disable it.

After adding a credential, run abtars restart --cold so the new bridge process loads it.

## Text-to-speech

Text-to-speech uses Microsoft Edge TTS. It is enabled by default. Set TTS_ENABLED=false to disable it, or set TTS_VOICE to choose a voice.

## Platform support

| Platform | Speech-to-text | Text-to-speech |
|----------|----------------|-----------------|
| Telegram | Supported | Supported |
| Discord | Not currently supported | Not currently supported |

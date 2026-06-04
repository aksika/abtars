/**
 * Voice transcription middleware — converts voice notes to text.
 */

import type { Middleware } from "./middleware.js";
import { transcribeAudio } from "../stt.js";
import { logError } from "../logger.js";

export const voiceMiddleware: Middleware = async (ctx, next) => {
  const { msg, adapter, deps } = ctx;

  if (msg.isVoice && msg.voiceFileId && adapter.downloadVoice && deps.sttConfig) {
    try {
      if (adapter.setReaction && msg.messageId) {
        await adapter.setReaction(msg.channelId, msg.messageId, "👀");
      }
      const audioBuffer = await adapter.downloadVoice(msg.voiceFileId);
      const { text: transcript, language } = await transcribeAudio(audioBuffer, "voice.ogg", deps.sttConfig);
      if (!transcript) {
        if (adapter.setReaction && msg.messageId) await adapter.setReaction(msg.channelId, msg.messageId, "");
        await ctx.reply("🤷 Couldn't transcribe the voice note.");
        ctx.handled = true;
        return;
      }
      const langTag = language ? `, ${language}` : "";
      ctx.text = `[🎤 voice${langTag}] ${transcript}`;
    } catch (err) {
      logError("voice-mw", "Voice transcription failed", err);
      if (adapter.setReaction && msg.messageId) await adapter.setReaction(msg.channelId, msg.messageId, "");
      await ctx.reply("❌ Voice transcription failed.");
      ctx.handled = true;
      return;
    }
  } else if (msg.isVoice && !deps.sttConfig) {
    await ctx.reply("🎤 Voice notes require STT (set GROQ_API_KEY).");
    ctx.handled = true;
    return;
  }

  await next();
};

/** Minimal Telegram Bot API types — only what the bridge uses. */

export type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
};

export type TelegramChat = {
  id: number;
  type: string;
  is_forum?: boolean;
};

export type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  voice?: TelegramAudio;
  audio?: TelegramAudio;
  photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[];
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
};

export type TelegramAudio = {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
};

export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

export type TelegramReactionType = {
  type: "emoji";
  emoji: string;
};

export type TelegramMessageReactionUpdated = {
  chat: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReactionUpdated;
};

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

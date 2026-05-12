import net from "node:net";
import tls from "node:tls";
import { logInfo, logWarn, logDebug } from "../../components/logger.js";

const TAG = "irc-client";

export interface IrcClientOptions {
  host: string;
  port: number;
  useTls: boolean;
  nick: string;
  nickservPassword?: string;
  channels: string[];
  onPrivmsg: (sender: string, target: string, text: string, hostmask: string) => void;
  onReady?: () => void;
  onDisconnect?: () => void;
}

export interface IrcClient {
  send: (target: string, text: string) => void;
  quit: (reason?: string) => void;
  readonly nick: string;
}

export function createIrcClient(opts: IrcClientOptions): IrcClient {
  let socket: net.Socket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectDelay = 5000;
  let registered = false;
  let stopped = false;
  let sendQueue: string[] = [];
  let sendTimer: NodeJS.Timeout | null = null;
  let buffer = "";

  function connect(): void {
    if (stopped) return;
    registered = false;
    buffer = "";

    const onConnect = (): void => {
      logInfo(TAG, `Connected to ${opts.host}:${opts.port}`);
      reconnectDelay = 5000;
      raw(`NICK ${opts.nick}`);
      raw(`USER ${opts.nick} 0 * :abtars`);
    };

    if (opts.useTls) {
      socket = tls.connect({ host: opts.host, port: opts.port, rejectUnauthorized: false }, onConnect);
    } else {
      socket = net.createConnection({ host: opts.host, port: opts.port }, onConnect);
    }

    socket.setEncoding("utf-8");
    socket.on("data", onData);
    socket.on("error", (err) => {
      if (reconnectDelay <= 5000) logWarn(TAG, `Socket error: ${err.message}`);
      else logDebug(TAG, `Socket error (reconnecting): ${err.message}`);
    });
    socket.on("close", () => {
      if (reconnectDelay <= 5000) logWarn(TAG, `Disconnected from ${opts.host}`);
      opts.onDisconnect?.();
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      if (reconnectDelay <= 10000) logInfo(TAG, `Reconnecting to ${opts.host}:${opts.port}...`);
      else logDebug(TAG, `Reconnecting to ${opts.host}:${opts.port} (delay=${Math.round(reconnectDelay/1000)}s)...`);
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 300000);
  }

  function raw(line: string): void {
    socket?.write(line + "\r\n");
  }

  function onData(chunk: string): void {
    buffer += chunk;
    const lines = buffer.split("\r\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line) handleLine(line);
    }
  }

  function handleLine(line: string): void {
    if (line.startsWith("PING")) {
      raw("PONG" + line.slice(4));
      return;
    }

    const parts = line.split(" ");
    const code = parts[1];

    // 001 RPL_WELCOME — registration complete
    if (code === "001" && !registered) {
      registered = true;
      if (opts.nickservPassword) {
        raw(`PRIVMSG NickServ :IDENTIFY ${opts.nickservPassword}`);
        // Join after short delay to let NickServ process
        setTimeout(joinChannels, 2000);
      } else {
        joinChannels();
      }
      return;
    }

    // PRIVMSG
    if (code === "PRIVMSG") {
      const prefix = parts[0]!.slice(1); // remove leading ':'
      const sender = prefix.split("!")[0]!;
      const target = parts[2]!;
      const textStart = line.indexOf(":", line.indexOf("PRIVMSG") + 8);
      const text = textStart >= 0 ? line.slice(textStart + 1) : "";
      opts.onPrivmsg(sender, target, text, prefix);
      return;
    }
  }

  function joinChannels(): void {
    for (const ch of opts.channels) {
      raw(`JOIN ${ch}`);
    }
    logInfo(TAG, `Joined: ${opts.channels.join(", ")}`);
    opts.onReady?.();
  }

  // Rate-limited send: 1 msg/sec
  function flushQueue(): void {
    if (sendQueue.length === 0) {
      sendTimer = null;
      return;
    }
    const msg = sendQueue.shift()!;
    raw(msg);
    sendTimer = setTimeout(flushQueue, 1000);
  }

  function sendPrivmsg(target: string, text: string): void {
    const line = `PRIVMSG ${target} :${text}`;
    sendQueue.push(line);
    if (!sendTimer) {
      sendTimer = setTimeout(flushQueue, 0);
    }
  }

  connect();

  return {
    nick: opts.nick,
    send: sendPrivmsg,
    quit(reason?: string): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sendTimer) clearTimeout(sendTimer);
      raw(`QUIT :${reason ?? "bye"}`);
      setTimeout(() => socket?.destroy(), 1000);
    },
  };
}

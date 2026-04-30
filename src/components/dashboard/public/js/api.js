/** api.js — fetch helpers for dashboard REST endpoints. */

const TOKEN_KEY = "dashboard_token";

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || new URLSearchParams(location.search).get("token") || "";
}

export function setToken(t) {
  sessionStorage.setItem(TOKEN_KEY, t);
}

function headers() {
  return { "Authorization": `Bearer ${getToken()}`, "Content-Type": "application/json" };
}

export async function fetchStatus() {
  const res = await fetch("/api/status", { headers: headers() });
  return res.json();
}

export async function fetchLogs(level = [], limit = 500) {
  const params = new URLSearchParams();
  if (level.length) params.set("level", level.join(","));
  params.set("limit", String(limit));
  const res = await fetch(`/api/logs?${params}`, { headers: headers() });
  return res.json();
}

export async function fetchCron() {
  const res = await fetch("/api/cron", { headers: headers() });
  return res.json();
}

export async function searchMemory(params) {
  const res = await fetch(`/api/memory/search?${params}`, { headers: headers() });
  return res.json();
}

export async function listChats() {
  const res = await fetch("/api/memory/chats", { headers: headers() });
  return res.json();
}

export async function toggleService(name, action) {
  const res = await fetch(`/api/services/${name}/${action}`, { method: "POST", headers: headers() });
  return res.json();
}

export async function cronAction(id, action) {
  const res = await fetch(`/api/cron/${id}/${action}`, { method: "POST", headers: headers() });
  return res.json();
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:2020";
const TOKEN_KEY = "myra_auth_token";

function headers() {
  const token = localStorage.getItem(TOKEN_KEY);
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function send(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    headers: headers(),
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data.data ?? data;
}

export const libraryApi = {
  saveNote: (content, title) => send("/library/notes", {
    method: "POST",
    body: JSON.stringify({ content, title }),
  }),
  addReminder: (title, due) => send("/library/reminders", {
    method: "POST",
    body: JSON.stringify({ title, due }),
  }),
  completeReminder: (id) => send(`/library/reminders/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ done: true }),
  }),
};

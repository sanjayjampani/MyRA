const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:2020";

const TOKEN_KEY = "myra_auth_token";
const DEVICE_KEY = "myra_device";

export function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function authHeaders() {
  const token = localStorage.getItem(TOKEN_KEY);
  return {
    "Content-Type": "application/json",
    "X-MyRa-Device": deviceId(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export const authApi = {
  loginWithGoogle: async () => {
    try {
      const response = await fetch(
        `${API_BASE_URL}/auth/google/login`,
        {
          method: "GET",
          credentials: "include",
        }
      );

      if (!response.ok) {
        throw new Error("Failed to initiate Google login");
      }

      const data = await response.json();

      if (data.success && data.data?.authUrl) {
        // OAuth must redirect the browser
        window.location.href = data.data.authUrl;
      } else {
        throw new Error("Invalid response from server");
      }
    } catch (error) {
      console.error("Google login error:", error);
      throw error;
    }
  },

  exchangeLoginCode: async (code) => {
    const response = await fetch(`${API_BASE_URL}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code, deviceId: deviceId() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.data?.token) {
      throw new Error(data.error || "Login code is invalid or expired");
    }
    return data.data.token;
  },

  getToken: () => {
    return localStorage.getItem(TOKEN_KEY);
  },

  setToken: (token) => {
    localStorage.setItem(TOKEN_KEY, token);
  },

  removeToken: () => {
    localStorage.removeItem(TOKEN_KEY);
  },

  getCurrentUser: async () => {
    const token = localStorage.getItem(TOKEN_KEY);

    if (!token) return null;

    try {
      const response = await fetch(`${API_BASE_URL}/auth/me`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-MyRa-Device": deviceId(),
        },
        credentials: "include",
      });

      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem(TOKEN_KEY);
          return null;
        }
        throw new Error("Failed to get user");
      }

      const data = await response.json();

      if (data.success && data.data?.user) {
        return data.data.user;
      }

      return null;
    } catch (error) {
      console.error("Get current user error:", error);
      return null;
    }
  },

  getSettings: async () => {
    const response = await fetch(`${API_BASE_URL}/auth/preferences`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!response.ok) return {};
    const data = await response.json();
    return data.data || {};
  },

  saveSettings: async (patch) => {
    const response = await fetch(`${API_BASE_URL}/auth/preferences`, {
      method: "PUT",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error("Failed to save settings");
    const data = await response.json();
    return data.data || {};
  },

  exportAccount: async () => {
    const response = await fetch(`${API_BASE_URL}/auth/export`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!response.ok) throw new Error("Failed to export account");
    return response.json();
  },

  deleteAccount: async () => {
    const response = await fetch(`${API_BASE_URL}/auth/account`, {
      method: "DELETE",
      headers: authHeaders(),
      credentials: "include",
    });
    if (!response.ok) throw new Error("Failed to delete account");
  },

  providerStatus: async () => {
    const response = await fetch(`${API_BASE_URL}/auth/providers`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!response.ok) return { openai: false, anthropic: false };
    const data = await response.json();
    return data.data || { openai: false, anthropic: false };
  },

  reportTelemetry: async (message) => {
    await fetch(`${API_BASE_URL}/auth/telemetry`, {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
      body: JSON.stringify({ message }),
    }).catch(() => {});
  },

  logout: async () => {
    const token = localStorage.getItem(TOKEN_KEY);

    try {
      if (token) {
        await fetch(`${API_BASE_URL}/auth/logout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          credentials: "include",
        });
      }
    } catch (error) {
      console.error("Logout error:", error);
    } finally {
      localStorage.removeItem(TOKEN_KEY);
    }
  },
};

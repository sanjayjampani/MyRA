import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Database,
  Download,
  KeyRound,
  Palette,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useAuthStore } from "../store/authStore";
import useSyncStore from "../store/syncStore";
import {
  DEFAULT_LLM_MODEL_ID,
  LLM_MODEL_OPTIONS,
} from "../constants/llmModels";
import ApiBudgetSettings from "../components/settings/ApiBudgetSettings";
import { authApi } from "../api/auth";

const SETTINGS_NAV_ITEMS = [
  { id: "models", label: "Models & API", icon: KeyRound },
  { id: "budgets", label: "API budgets", icon: Bell },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "sources", label: "Data sources", icon: Database },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "privacy", label: "Privacy & data", icon: ShieldCheck },
];

export default function SettingsPage({
  theme = "light",
  onThemeChange = () => {},
  onNavigate = () => {},
}) {
  const { user } = useAuthStore();
  const { gmail, calendar } = useSyncStore();
  const [activeSection, setActiveSection] = useState("models");
  const [defaultModel, setDefaultModel] = useState(DEFAULT_LLM_MODEL_ID);
  const [density, setDensity] = useState("comfortable");
  const [security, setSecurity] = useState({ reauth: true });
  const [notifications, setNotifications] = useState({
    daily: true,
    weekly: false,
  });
  const [privacy, setPrivacy] = useState({
    indexData: true,
    telemetry: false,
  });
  const [providers, setProviders] = useState({ openai: false, anthropic: false });
  const [sessionTimeout, setSessionTimeout] = useState("8");
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    authApi.getSettings().then((settings) => {
      if (settings.defaultModel) setDefaultModel(settings.defaultModel);
      if (settings.density) {
        setDensity(settings.density);
        document.documentElement.dataset.density = settings.density === "compact" ? "compact" : "comfortable";
      }
      if (settings.theme) onThemeChange(settings.theme);
      if (typeof settings.reauth === "boolean") setSecurity({ reauth: settings.reauth });
      else setSecurity({ reauth: false });
      if (settings.sessionTimeoutHours) setSessionTimeout(String(settings.sessionTimeoutHours));
      setNotifications({
        daily: settings.dailySummary !== false,
        weekly: Boolean(settings.weeklyReview),
      });
      setPrivacy({
        indexData: settings.indexData !== false,
        telemetry: Boolean(settings.telemetry),
      });
    }).catch(() => {});
    authApi.providerStatus().then(setProviders).catch(() => {});
  }, [onThemeChange]);

  function save(patch) {
    authApi.saveSettings(patch).catch(() => {});
  }

  async function syncSource(source) {
    const token = authApi.getToken();
    await fetch(`${import.meta.env.VITE_API_BASE_URL || "http://localhost:2020"}/sync/${source}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ syncType: "incremental" }),
    });
  }

  async function exportData() {
    const payload = await authApi.exportAccount();
    const blob = new Blob([JSON.stringify(payload.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "myra-export.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function deleteAccount() {
    if (!window.confirm("Delete this account and its synced data?")) return;
    await authApi.deleteAccount();
    await authApi.logout();
    onNavigate("login");
  }

  const sourceRows = [
    { name: "Gmail", state: gmail },
    { name: "Google Calendar", state: calendar },
  ];

  function openSection(sectionId) {
    setActiveSection(sectionId);
  }

  return (
    <div className="myra-page-inner myra-settings-page">
      <header className="myra-page-opening">
        <h1 className="display">Settings</h1>
        <p>Manage models, budgets, connected data, and preferences</p>
      </header>

      <div className="myra-settings-window">
        <aside className="myra-settings-window-sidebar">
          <div className="myra-settings-nav-heading">Settings menu</div>
          <nav
            className="myra-settings-nav"
            aria-label="Settings sections"
            role="tablist"
          >
            {SETTINGS_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={`myra-settings-nav-button ${activeSection === item.id ? "active" : ""}`}
                  type="button"
                  key={item.id}
                  onClick={() => openSection(item.id)}
                  id={`settings-tab-${item.id}`}
                  role="tab"
                  aria-selected={activeSection === item.id}
                  aria-controls={`settings-panel-${item.id}`}
                >
                  <Icon size={15} strokeWidth={1.7} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div
          key={activeSection}
          className="myra-settings-window-content"
          id={`settings-panel-${activeSection}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeSection}`}
        >
      {activeSection === "models" && (
      <SettingsSection
        sectionId="models"
        title="Models & API"
        icon={<KeyRound size={15} strokeWidth={1.7} />}
      >
        <SettingsRow label="Default chat model" description="Used for new chats and daily summaries">
          <select
            className="myra-input myra-settings-control"
            value={defaultModel}
            onChange={(event) => {
              setDefaultModel(event.target.value);
              save({ defaultModel: event.target.value });
            }}
          >
            {LLM_MODEL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.provider} - {option.displayName}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow label="OpenAI API key" description="Lives in the server environment, not the browser">
          <button className="myra-btn secondary sm" type="button" disabled>
            {providers.openai ? "Configured" : "Missing"}
          </button>
        </SettingsRow>
        <SettingsRow label="Anthropic API key" description="Lives in the server environment, not the browser">
          <button className="myra-btn secondary sm" type="button" disabled>
            {providers.anthropic ? "Configured" : "Missing"}
          </button>
        </SettingsRow>
      </SettingsSection>
      )}

      {activeSection === "budgets" && (
      <div
        className="myra-settings-page-panel"
        id="settings-budgets"
      >
        <ApiBudgetSettings />
      </div>
      )}

      {activeSection === "appearance" && (
      <SettingsSection
        sectionId="appearance"
        title="Appearance"
        icon={<Palette size={15} strokeWidth={1.7} />}
      >
        <SettingsRow label="Account" description={user?.email || "No signed-in account"}>
          <span className="myra-badge">{user?.user_name || user?.name || "Guest"}</span>
        </SettingsRow>
        <SettingsRow label="Theme" description="Use the Classic daylight or evergreen dark palette">
          <div className="myra-pills">
            <button
              className={theme !== "dark" ? "active" : ""}
              onClick={() => { onThemeChange("light"); save({ theme: "light" }); }}
              type="button"
            >
              Light
            </button>
            <button
              className={theme === "dark" ? "active" : ""}
              onClick={() => { onThemeChange("dark"); save({ theme: "dark" }); }}
              type="button"
            >
              Dark
            </button>
          </div>
        </SettingsRow>
        <SettingsRow label="Density" description="Adjust spacing without changing the visual language">
          <div className="myra-pills">
            <button
              className={density === "comfortable" ? "active" : ""}
              onClick={() => {
                setDensity("comfortable");
                document.documentElement.dataset.density = "comfortable";
                save({ density: "comfortable" });
              }}
              type="button"
            >
              Comfortable
            </button>
            <button
              className={density === "compact" ? "active" : ""}
              onClick={() => {
                setDensity("compact");
                document.documentElement.dataset.density = "compact";
                save({ density: "compact" });
              }}
              type="button"
            >
              Compact
            </button>
          </div>
        </SettingsRow>
      </SettingsSection>
      )}

      {activeSection === "sources" && (
      <SettingsSection
        sectionId="sources"
        title="Data sources"
        icon={<Database size={15} strokeWidth={1.7} />}
      >
        {sourceRows.map((source) => {
          const errored = source.state.syncPhase === "error";
          const syncing = source.state.isSyncing;
          return (
            <SettingsRow
              key={source.name}
              label={source.name}
              description={syncing
                ? source.state.syncMessage || "Sync in progress"
                : "Connected through your Google account"}
            >
              <div className="myra-settings-row-actions">
                <span className={`myra-badge ${errored ? "danger" : syncing ? "warning" : "success"}`}>
                  {errored ? "Sync failed" : syncing ? "Syncing" : "Connected"}
                </span>
                <button
                  className="myra-btn secondary sm"
                  onClick={() => onNavigate("profile")}
                  type="button"
                >
                  Manage
                </button>
              </div>
            </SettingsRow>
          );
        })}
        <SettingsRow label="Google Drive" description="Included the next time you sign in with Google">
          <button className="myra-btn secondary sm" type="button" onClick={() => syncSource("drive")}>
            Sync
          </button>
        </SettingsRow>
      </SettingsSection>
      )}

      {activeSection === "security" && (
      <SettingsSection
        sectionId="security"
        title="Security"
        icon={<ShieldCheck size={15} strokeWidth={1.7} />}
      >
        <SettingsRow label="Ask for re-auth on new devices" description="Protect access to connected data">
          <Toggle
            on={security.reauth}
            onClick={() => setSecurity((value) => {
              const reauth = !value.reauth;
              save({ reauth });
              return { reauth };
            })}
            label="Require re-authentication"
          />
        </SettingsRow>
        <SettingsRow label="Session timeout" description="Sign out after inactivity">
          <select
            className="myra-input myra-settings-control"
            value={sessionTimeout}
            onChange={(event) => {
              setSessionTimeout(event.target.value);
              save({ sessionTimeoutHours: Number(event.target.value) });
            }}
          >
            <option value="1">1 hour</option>
            <option value="8">8 hours</option>
            <option value="24">24 hours</option>
          </select>
        </SettingsRow>
      </SettingsSection>
      )}

      {activeSection === "notifications" && (
      <SettingsSection
        sectionId="notifications"
        title="Notifications"
        icon={<Bell size={15} strokeWidth={1.7} />}
      >
        <SettingsRow label="Daily summary" description="A morning digest of important items">
          <Toggle
            on={notifications.daily}
            onClick={() => setNotifications((value) => {
              const daily = !value.daily;
              save({ dailySummary: daily });
              return { ...value, daily };
            })}
            label="Daily summary notifications"
          />
        </SettingsRow>
        <SettingsRow label="Weekly review" description="A Sunday recap of the week">
          <Toggle
            on={notifications.weekly}
            onClick={() => setNotifications((value) => {
              const weekly = !value.weekly;
              save({ weeklyReview: weekly });
              return { ...value, weekly };
            })}
            label="Weekly review notifications"
          />
        </SettingsRow>
      </SettingsSection>
      )}

      {activeSection === "privacy" && (
      <SettingsSection
        sectionId="privacy"
        title="Privacy & data"
        icon={<ShieldCheck size={15} strokeWidth={1.7} />}
      >
        <SettingsRow label="Index connected data" description="Required for personal retrieval features">
          <Toggle
            on={privacy.indexData}
            onClick={() => setPrivacy((value) => {
              const indexData = !value.indexData;
              save({ indexData });
              return { ...value, indexData };
            })}
            label="Index connected data"
          />
        </SettingsRow>
        <SettingsRow label="Share anonymous telemetry" description="Help identify product errors">
          <Toggle
            on={privacy.telemetry}
            onClick={() => setPrivacy((value) => {
              const telemetry = !value.telemetry;
              save({ telemetry });
              return { ...value, telemetry };
            })}
            label="Share anonymous telemetry"
          />
        </SettingsRow>
        <SettingsRow label="Export your data" description="Download indexed content and chat history">
          <button className="myra-btn secondary sm" type="button" onClick={exportData}>
            <Download size={14} strokeWidth={1.7} />
            Export
          </button>
        </SettingsRow>
        <SettingsRow label="Delete account" description="Permanently remove your account and synced data">
          <button className="myra-btn danger sm" type="button" onClick={deleteAccount}>
            <Trash2 size={14} strokeWidth={1.7} />
            Delete
          </button>
        </SettingsRow>
      </SettingsSection>
      )}
        </div>
      </div>
    </div>
  );
}

function SettingsSection({ sectionId, title, icon, children }) {
  return (
    <section
      className="myra-card myra-settings-section myra-settings-anchor"
      id={`settings-${sectionId}`}
    >
      <div className="myra-card-header">
        <h3>{icon}{title}</h3>
      </div>
      <div>{children}</div>
    </section>
  );
}

function SettingsRow({ label, description, children }) {
  return (
    <div className="myra-settings-row">
      <div>
        <div className="myra-settings-row-label">{label}</div>
        {description && <div className="desc">{description}</div>}
      </div>
      <div className="myra-settings-row-value">{children}</div>
    </div>
  );
}

function Toggle({ on, onClick, label }) {
  return (
    <button
      className={"myra-toggle" + (on ? " on" : "")}
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      type="button"
    />
  );
}

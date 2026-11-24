import { useState, useEffect } from "react";
import ChatPage from "./pages/ChatPage";
import LoginPage from "./pages/LoginPage";
import ProfilePage from "./pages/ProfilePage";
import AuthCallbackPage from "./pages/AuthCallbackPage";
import HomePage from "./pages/HomePage";
import PrivacyPolicyPage from "./pages/PrivacyPolicyPage";
import StatsPage from "./pages/StatsPage";
import SettingsPage from "./pages/SettingsPage";
import TermsOfServicePage from "./pages/TermsOfServicePage";
import Sidebar from "./components/layout/Sidebar";
import MyraVoiceActivation from "./components/voice/MyraVoiceActivation";
import { useAuthStore } from "./store/authStore";
import { authApi, deviceId } from "./api/auth";
import { Moon, PanelLeft, Sun } from "lucide-react";
import { DEFAULT_LLM_MODEL_ID, getLlmModelOption } from "./constants/llmModels";

const THEME_STORAGE_KEY = "myra-theme";

// ── URL ↔ page mapping ────────────────────────────────────────────────────────
const PATH_TO_PAGE = {
  "/":              "home",
  "/chat":          "chat",
  "/stats":         "stats",
  "/settings":      "settings",
  "/profile":       "profile",
  "/login":         "login",
  "/privacy":       "privacy",
  "/terms":         "terms",
  "/auth/callback": "auth-callback",
};
const PAGE_TO_PATH = Object.fromEntries(Object.entries(PATH_TO_PAGE).map(([k, v]) => [v, k]));

function pageFromURL() {
  return PATH_TO_PAGE[window.location.pathname] ?? "home";
}

function App() {
  const [currentPage, setCurrentPage] = useState(pageFromURL);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [sidebarExpanded, setSidebarExpanded] = useState(!isMobile);
  const [theme, setTheme] = useState(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "dark") return "dark";
    if (storedTheme === "light" || storedTheme === "warm") return "light";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const { setUser, setLoading, logout } = useAuthStore();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === "dark" ? "dark" : "light";
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Handle window resize for mobile responsiveness
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      // Collapse sidebar on mobile unless user just expanded
      if (mobile && sidebarExpanded) {
        setSidebarExpanded(false);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [sidebarExpanded]);

  // Keep URL in sync and handle browser back/forward
  useEffect(() => {
    const onPop = () => setCurrentPage(pageFromURL());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const checkAuth = async () => {
      if (currentPage === "auth-callback") return;
      setLoading(true);
      try {
        const user = await authApi.getCurrentUser();
        if (user) setUser(user);
      } catch (error) {
        console.error("Auth check failed:", error);
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, [setUser, setLoading, currentPage]);

  useEffect(() => {
    if (currentPage === "login" || currentPage === "auth-callback") return undefined;
    let stopped = false;
    const last = { at: Date.now() };
    let idleHours = 0;
    let telemetry = false;
    const bump = () => { last.at = Date.now(); };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    authApi.getSettings().then((settings) => {
      if (stopped) return;
      const known = Array.isArray(settings.knownDevices) ? settings.knownDevices : [];
      if (settings.reauth === true && !known.includes(deviceId())) {
        authApi.logout();
        logout();
        window.history.pushState({}, "", "/login");
        setCurrentPage("login");
        return;
      }
      const hours = Number(settings.sessionTimeoutHours || 8);
      idleHours = hours === 1 || hours === 8 || hours === 24 ? hours : 0;
      telemetry = settings.telemetry === true;
      document.documentElement.dataset.density = settings.density === "compact" ? "compact" : "comfortable";
    }).catch(() => {});
    const onError = (event) => {
      if (!telemetry) return;
      authApi.reportTelemetry(String(event?.message || "client error").slice(0, 200));
    };
    window.addEventListener("error", onError);
    const timer = window.setInterval(() => {
      if (!idleHours) return;
      if (Date.now() - last.at > idleHours * 60 * 60 * 1000) {
        authApi.logout();
        logout();
        window.history.pushState({}, "", "/login");
        setCurrentPage("login");
      }
    }, 60000);
    return () => {
      stopped = true;
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
      window.removeEventListener("error", onError);
      window.clearInterval(timer);
    };
  }, [currentPage, logout]);

  const handleNavigate = (page) => {
    const path = PAGE_TO_PATH[page] ?? "/";
    window.history.pushState({}, "", path);
    setCurrentPage(page);
    // Close sidebar on mobile after navigation
    if (isMobile) setSidebarExpanded(false);
  };

  const handleToggleSidebar = () => setSidebarExpanded((v) => !v);

  const renderPage = () => {
    switch (currentPage) {
      case "auth-callback": return <AuthCallbackPage onNavigate={handleNavigate} />;
      case "login":         return <LoginPage onNavigate={handleNavigate} theme={theme} onThemeChange={setTheme} />;
      case "profile":       return <ProfilePage onNavigate={handleNavigate} />;
      case "home":          return <HomePage onNavigate={handleNavigate} />;
      case "privacy":       return <PrivacyPolicyPage onNavigate={handleNavigate} />;
      case "stats":         return <StatsPage onNavigate={handleNavigate} />;
      case "settings":      return <SettingsPage theme={theme} onThemeChange={setTheme} onNavigate={handleNavigate} />;
      case "terms":         return <TermsOfServicePage onNavigate={handleNavigate} />;
      case "chat":
      default:
        return (
          <ChatPage
            onNavigate={handleNavigate}
            onToggleSidebar={handleToggleSidebar}
            theme={theme}
            onThemeChange={setTheme}
          />
        );
    }
  };

  // Authentication stays outside the signed-in workspace shell.
  if (currentPage === "auth-callback" || currentPage === "login") {
    return <div className="myra-app" data-theme={theme}>{renderPage()}</div>;
  }

  return (
    <div
      className="myra-app myra-classic-shell"
      data-theme={theme}
      data-mobile={isMobile}
    >
      {isMobile && (
        <button
          className={"myra-sidebar-backdrop" + (sidebarExpanded ? " is-visible" : "")}
          onClick={() => setSidebarExpanded(false)}
          aria-label="Close navigation"
          aria-hidden="true"
        />
      )}
      <Sidebar
        onNavigate={handleNavigate}
        currentPage={currentPage}
        isExpanded={sidebarExpanded}
        onToggle={handleToggleSidebar}
        isMobile={isMobile}
      />
      <section className="myra-workspace">
        {currentPage === "chat" ? (
          renderPage()
        ) : (
          <>
            <WorkspaceHeader
              currentPage={currentPage}
              onNavigate={handleNavigate}
              onToggleSidebar={handleToggleSidebar}
              theme={theme}
              onThemeChange={setTheme}
            />
            <main className="myra-page">{renderPage()}</main>
          </>
        )}
      </section>
      <MyraVoiceActivation currentPage={currentPage} onNavigate={handleNavigate} />
    </div>
  );
}

function WorkspaceHeader({ currentPage, onNavigate, onToggleSidebar, theme, onThemeChange }) {
  const { user, isAuthenticated } = useAuthStore();
  const getInitials = (name) => {
    if (!name) return "U";
    return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
  };
  const pageMeta = {
    home: ["Home", "Your workspace today"],
    stats: ["Usage", "Activity across connected services"],
    profile: ["Profile", "Account and connected sources"],
    settings: ["Settings", "Models, security, privacy"],
    privacy: ["Privacy Policy", "How MyRa handles your data"],
    terms: ["Terms of Service", "The terms for using MyRa"],
  };
  const [title, subtitle] = pageMeta[currentPage] || pageMeta.home;
  const defaultModel = getLlmModelOption(DEFAULT_LLM_MODEL_ID);

  return (
    <header className="myra-workspace-header">
      <div className="myra-workspace-heading">
        <button
          className="myra-btn ghost icon sm"
          onClick={onToggleSidebar}
          aria-label="Toggle navigation"
        >
          <PanelLeft size={17} strokeWidth={1.7} />
        </button>
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
      </div>
      <div className="myra-workspace-actions">
        <span className="myra-badge model-badge">
          {defaultModel.displayName}
        </span>
        <button
          className="myra-btn ghost icon sm"
          onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
        >
          {theme === "dark"
            ? <Sun size={17} strokeWidth={1.7} />
            : <Moon size={17} strokeWidth={1.7} />}
        </button>
        <button
          className="myra-avatar"
          onClick={() => onNavigate("profile")}
          aria-label="Profile"
        >
          {isAuthenticated && user?.picture
            ? <img src={user.picture} alt={user.name || "Profile"} />
            : getInitials(user?.name)}
        </button>
      </div>
    </header>
  );
}

export default App;

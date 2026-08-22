import { useEffect, useState } from "react";

type ResolvedTheme = "dark" | "light";
type ThemePreference = ResolvedTheme | "system";

const themePreferenceKey = "voice-agent.theme";
const darkThemeColor = "#101713";
const lightThemeColor = "#f4f0e8";
const themeOptions: readonly {
  label: string;
  value: ThemePreference;
}[] = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const initialThemePreference = readThemePreference();
applyThemePreference(initialThemePreference);

export function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>(
    initialThemePreference,
  );

  useEffect(() => {
    applyThemePreference(preference);
    if (preference !== "system") return;

    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const applySystemTheme = () => applyThemePreference("system");
    systemTheme.addEventListener("change", applySystemTheme);
    return () => systemTheme.removeEventListener("change", applySystemTheme);
  }, [preference]);

  useEffect(() => {
    const useStoredPreference = (event: StorageEvent) => {
      if (event.key === themePreferenceKey) {
        setPreference(readThemePreference());
      }
    };
    window.addEventListener("storage", useStoredPreference);
    return () => window.removeEventListener("storage", useStoredPreference);
  }, []);

  function selectPreference(nextPreference: ThemePreference) {
    writeThemePreference(nextPreference);
    applyThemePreference(nextPreference);
    setPreference(nextPreference);
  }

  return (
    <fieldset className="theme-control">
      <legend className="visually-hidden">Appearance</legend>
      {themeOptions.map((option) => (
        <button
          aria-pressed={preference === option.value}
          key={option.value}
          onClick={() => selectPreference(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

function applyThemePreference(preference: ThemePreference): void {
  const resolvedTheme = resolveTheme(preference);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themePreference = preference;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute(
      "content",
      resolvedTheme === "dark" ? darkThemeColor : lightThemeColor,
    );
}

function readThemePreference(): ThemePreference {
  try {
    const storedPreference = localStorage.getItem(themePreferenceKey);
    if (storedPreference === "dark" || storedPreference === "light") {
      return storedPreference;
    }
  } catch {
    // System appearance remains available when browser storage is unavailable.
  }
  return "system";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function writeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") localStorage.removeItem(themePreferenceKey);
    else localStorage.setItem(themePreferenceKey, preference);
  } catch {
    // The in-memory choice still applies for this page lifetime.
  }
}

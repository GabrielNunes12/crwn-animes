import { useBoolPref } from "../../hooks/usePref.js";
import { useT } from "../../i18n/useT.js";
import { SINGLE_KEY_SHORTCUTS_KEY } from "../../lib/prefs.js";

/** WCAG 2.1.4: single-character shortcuts (T, /, ?) can be turned off. */
export function SingleKeyToggle() {
  const { t } = useT();
  const [on, setOn] = useBoolPref(SINGLE_KEY_SHORTCUTS_KEY, true);
  return (
    <label className="checkbox">
      <input type="checkbox" role="switch" checked={on} onChange={(e) => setOn(e.target.checked)} />
      <span>
        {t("shortcuts.singleKey")}
        <span className="hint" style={{ display: "block" }}>
          {t("shortcuts.singleKeyHint")}
        </span>
      </span>
    </label>
  );
}

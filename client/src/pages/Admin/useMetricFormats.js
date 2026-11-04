import { useMemo } from "react";
import { useT } from "../../i18n/useT.js";

const UTC_DAY = (day) => new Date(`${day}T00:00:00Z`);

/**
 * Intl formatters for the Métricas tab, built once per locale. Days ("YYYY-MM-DD")
 * are UTC calendar dates: they are formatted in UTC so they never shift by one.
 */
export function useMetricFormats() {
  const { locale } = useT();
  return useMemo(() => {
    const avg = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }); // pt-BR "14:32", en "2:32 PM"
    const shortDay = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
    const longDay = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const unit = (u, display = "long") => new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: display, maximumFractionDigits: u === "byte" ? 0 : 1 });
    const minutes = unit("minute");
    const hours = new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "long", maximumFractionDigits: 0 });
    const days = new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "long", maximumFractionDigits: 0 });
    const bytes = { byte: unit("byte", "short"), kilobyte: unit("kilobyte", "short"), megabyte: unit("megabyte", "short"), gigabyte: unit("gigabyte", "short") };
    return {
      average: (n) => avg.format(n),
      time: (iso) => time.format(new Date(iso)),
      shortDay: (day) => shortDay.format(UTC_DAY(day)),
      longDay: (day) => longDay.format(UTC_DAY(day)),
      /** 0.5 → "30 minutos", 5 → "5 horas", 50 → "2 dias". */
      age: (h) => {
        if (h == null || !Number.isFinite(Number(h))) return null;
        const hrs = Math.max(0, Number(h));
        if (hrs < 1) return minutes.format(Math.round(hrs * 60));
        if (hrs < 48) return hours.format(Math.round(hrs));
        return days.format(Math.round(hrs / 24));
      },
      bytes: (n) => {
        const v = Math.max(0, Number(n) || 0);
        if (v < 1024) return bytes.byte.format(v);
        if (v < 1024 ** 2) return bytes.kilobyte.format(v / 1024);
        if (v < 1024 ** 3) return bytes.megabyte.format(v / 1024 ** 2);
        return bytes.gigabyte.format(v / 1024 ** 3);
      },
    };
  }, [locale]);
}

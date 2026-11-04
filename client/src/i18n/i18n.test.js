import { describe, expect, it } from "vitest";
import { createI18n, createTranslator, detectLocale, MESSAGES } from "./core.js";
import { ApiError } from "../api/client.js";

function flatKeys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    const isPlural = v && typeof v === "object" && "other" in v;
    return v && typeof v === "object" && !isPlural ? flatKeys(v, key) : [key];
  });
}

describe("i18n", () => {
  const messages = {
    "pt-BR": { greet: "Olá, {name}", only: { pt: "só em pt" }, items: { one: "{count} item", other: "{count} itens" } },
    en: { greet: "Hello, {name}", onlyEn: "only in en", items: { one: "{count} item", other: "{count} items" } },
  };

  it("translates and interpolates", () => {
    expect(createTranslator("en", messages)("greet", { name: "Ana" })).toBe("Hello, Ana");
    expect(createTranslator("pt-BR", messages)("greet", { name: "Ana" })).toBe("Olá, Ana");
  });

  it("falls back to pt-BR, then en, then the key itself", () => {
    const en = createTranslator("en", messages);
    expect(en("only.pt")).toBe("só em pt");
    const pt = createTranslator("pt-BR", messages);
    expect(pt("onlyEn")).toBe("only in en");
    expect(pt("does.not.exist")).toBe("does.not.exist");
  });

  it("picks plural forms and formats numbers for the locale", () => {
    const en = createTranslator("en", messages);
    expect(en("items", { count: 1 })).toBe("1 item");
    expect(en("items", { count: 1200 })).toBe("1,200 items");
    expect(createTranslator("pt-BR", messages)("items", { count: 1200 })).toBe("1.200 itens");
  });

  it("detects the locale: saved choice, then navigator, default pt-BR", () => {
    expect(detectLocale("en", ["pt-BR"])).toBe("en");
    expect(detectLocale(null, ["en-US"])).toBe("en");
    expect(detectLocale(null, ["pt-PT"])).toBe("pt-BR");
    expect(detectLocale(null, ["fr-FR"])).toBe("pt-BR");
    expect(detectLocale("xx", [])).toBe("pt-BR");
  });

  it("ships the same keys in pt-BR and en", () => {
    expect(flatKeys(MESSAGES.en).sort()).toEqual(flatKeys(MESSAGES["pt-BR"]).sort());
  });

  it("never shows the server's English text: unknown codes fall back to errors.generic", () => {
    const pt = createI18n("pt-BR");
    expect(pt.errorMessage(new ApiError({ status: 500, code: "SOMETHING_NEW", message: "Raw English text" }))).toBe(MESSAGES["pt-BR"].errors.generic);
    expect(pt.errorMessage(new ApiError({ status: 500, code: "INTERNAL_ERROR", message: "Internal" }))).toBe(MESSAGES["pt-BR"].errors.INTERNAL_ERROR);
    expect(pt.errorMessage(new ApiError({ status: 413, code: "PAYLOAD_TOO_LARGE" }))).toBe(MESSAGES["pt-BR"].errors.PAYLOAD_TOO_LARGE);
    expect(pt.errorMessage(new ApiError({ status: 0, code: "HTTP_ERROR" }))).toBe(MESSAGES["pt-BR"].errors.HTTP_ERROR);
    expect(createI18n("en").errorMessage(new ApiError({ code: "WHATEVER", message: "server words" }))).toBe(MESSAGES.en.errors.generic);
  });

  it("translates VALIDATION_ERROR details per field, with a generic message for unknown fields", () => {
    const pt = createI18n("pt-BR");
    const err = new ApiError({ status: 400, code: "VALIDATION_ERROR", message: "Some fields are invalid.", details: { email: "Enter a valid e-mail address.", weird: "Bad." } });
    expect(pt.fieldErrors(err)).toEqual({ email: "Digite um e-mail válido.", weird: "Um dos campos não é válido." });
    const msg = pt.errorMessage(err);
    expect(msg).toContain("Digite um e-mail válido.");
    expect(msg).not.toMatch(/Enter a valid|invalid/);
  });

  it("its plural and number fast paths answer exactly like Intl (en, pt-BR)", () => {
    const samples = [0, 1, 2, 3, 5, 11, 21, 101, 999, 999.5, 1000, 1200, 1e6, 2e6, 0.5, 1.5, 1.0, 2.5, -1, -2, -0.5, -999];
    for (const locale of ["en", "pt-BR"]) {
      const msgs = { [locale]: { n: { one: "one {count}", many: "many {count}", other: "other {count}" } } };
      const t = createTranslator(locale, msgs);
      const pr = new Intl.PluralRules(locale);
      const nf = new Intl.NumberFormat(locale);
      for (const n of samples) expect(t("n", { count: n }), `${locale} ${n}`).toBe(`${pr.select(n)} ${nf.format(n)}`);
    }
  });
});


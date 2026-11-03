import { describe, expect, it } from "vitest";
import { createTranslator, detectLocale, MESSAGES } from "./core.js";

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
});

import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { registerMessages } from "../i18n/core.js";
import ptBR from "../i18n/pt-BR.json";
import en from "../i18n/en.json";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

// jsdom lacks matchMedia and IntersectionObserver.
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
}

// The dictionaries are lazy chunks in the app (main.jsx loads one before rendering); tests
// render synchronously, so both are registered up front.
registerMessages("pt-BR", ptBR);
registerMessages("en", en);

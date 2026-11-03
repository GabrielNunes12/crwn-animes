import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classify, normalize, parseYouTubeId } from "../src/classifier.js";
import { videoRoute } from "../src/routing.js";
import { SEED_SERIES } from "../src/seed.js";

const catalog = SEED_SERIES.map((s, i) => ({ id: i + 1, ...s }));
const routeOf = (r) => (r.status === "published" ? videoRoute(r) : null);

describe("classify(): realistic titles against the seed catalog", () => {
  const cases = [
    // [title, expected { section, seriesSlug, season, number, status }]
    ["One Piece Episode 1071 English Sub", { section: "anime", seriesSlug: "one-piece", season: 1, number: 1071, status: "published" }],
    ["ONE PIECE | Episódio 1000 | Legendado PT-BR", { section: "anime", seriesSlug: "one-piece", season: 1, number: 1000, status: "published" }],
    ["Naruto Shippuden Episódio 245 Dublado", { section: "anime", seriesSlug: "naruto-shippuden", season: 1, number: 245, status: "published" }],
    ["Naruto Shippuuden Ep 12 [Legendado]", { section: "anime", seriesSlug: "naruto-shippuden", number: 12, status: "published" }],
    ["One Piece Chapter 1100 Manga Motion Comic", { section: "manga", seriesSlug: "one-piece", season: 1, number: 1100, status: "published" }],
    ["One Piece Ch. 1100 - Full Manga Reading", { section: "manga", seriesSlug: "one-piece", number: 1100, status: "published" }],
    ["Chainsaw Man Capítulo 150 Manga Español", { section: "manga", seriesSlug: "chainsaw-man", number: 150, status: "published" }],
    ["Tokyo Ghoul Anime Capítulo 3 Sub Español", { section: "anime", seriesSlug: "tokyo-ghoul", number: 3, status: "published" }],
    ["Jujutsu Kaisen 2nd Season Episode 5", { section: "anime", seriesSlug: "jujutsu-kaisen", season: 2, number: 5, status: "published" }],
    ["Jujutsu Kaisen Season 2 Episode 1 - Hidden Inventory", { section: "anime", seriesSlug: "jujutsu-kaisen", season: 2, number: 1, status: "published" }],
    ["Jujutsu Kaisen Temporada 2 Episódio 3 Dublado", { section: "anime", seriesSlug: "jujutsu-kaisen", season: 2, number: 3, status: "published" }],
    ["Bleach S02E10 English Dub", { section: "anime", seriesSlug: "bleach", season: 2, number: 10, status: "published" }],
    ["Black Summoner (Kuro no Shoukanshi) - Episode 7 [English Sub]", { section: "anime", seriesSlug: "black-summoner", number: 7, status: "published" }],
    ["Chainsaw Man Episode 12 (2022) Official", { section: "anime", seriesSlug: "chainsaw-man", number: 12, status: "published" }],
    // Spanish "Capítulo" without other hints is ambiguous (manga chapter or anime episode).
    ["Tokyo Ghoul Capítulo 3 Sub Español", { section: null, seriesSlug: "tokyo-ghoul", status: "pending" }],
    ["Top 10 Strongest Characters in One Piece", { section: null, number: null, status: "pending" }],
    ["One Piece 1071", { section: null, number: null, status: "pending" }],
    ["Attack on Titan Episode 5", { section: "anime", seriesSlug: null, number: 5, status: "pending" }],
    ["Bleach Episode Recap Compilation", { section: null, seriesSlug: "bleach", number: null, status: "pending" }],
  ];

  for (const [title, expected] of cases) {
    test(title, () => {
      const result = classify({ title }, catalog);
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(result[key], value, `${key} for "${title}" (reasons: ${result.classification.reasons.join("; ")})`);
      }
    });
  }

  test("routes follow the front-end paths", () => {
    assert.equal(routeOf(classify({ title: "One Piece Episode 5" }, catalog)), "/anime/one-piece/episode/5");
    assert.equal(routeOf(classify({ title: "Jujutsu Kaisen 2nd Season Episode 5" }, catalog)), "/anime/jujutsu-kaisen/season/2/episode/5");
    assert.equal(routeOf(classify({ title: "One Piece Chapter 1100 Manga" }, catalog)), "/manga/one-piece/chapter/1100");
  });

  test('"Top 10" keeps the number only as a suggestion', () => {
    const result = classify({ title: "Top 10 Strongest Characters in One Piece" }, catalog);
    assert.equal(result.number, null);
    assert.equal(result.classification.suggestedNumber, 10);
  });

  test("admin overrides win over the title", () => {
    const result = classify({ title: "Top 10 Strongest Characters in One Piece" }, catalog, {
      section: "anime",
      seriesSlug: "one-piece",
      number: 999,
    });
    assert.equal(result.status, "published");
    assert.equal(result.number, 999);
    assert.equal(result.seriesSlug, "one-piece");
  });
});

describe("classify(): custom series lists", () => {
  test("numbers inside a series name are not episode numbers (Kaiju No. 8)", () => {
    const list = [{ id: 1, slug: "kaiju-no-8", name: "Kaiju No. 8", aliases: ["Kaijuu 8-gou"] }];
    const anime = classify({ title: "Kaiju No. 8 Episode 3 English Sub" }, list);
    assert.equal(anime.seriesSlug, "kaiju-no-8");
    assert.equal(anime.number, 3);
    assert.equal(anime.status, "published");

    const manga = classify({ title: "Kaiju No. 8 Manga Chapter 100" }, list);
    assert.equal(manga.section, "manga");
    assert.equal(manga.number, 100);

    const bare = classify({ title: "Kaiju No. 8 Anime" }, list);
    assert.equal(bare.number, null, "the 8 in the name must not become episode 8");
    assert.equal(bare.classification.suggestedNumber, null);
  });

  test("the longest matching name wins (Naruto Shippuden over Naruto)", () => {
    const list = [
      { id: 1, slug: "naruto", name: "Naruto", aliases: [] },
      { id: 2, slug: "naruto-shippuden", name: "Naruto Shippuden", aliases: [] },
    ];
    assert.equal(classify({ title: "Naruto Shippuden Episode 12" }, list).seriesSlug, "naruto-shippuden");
    assert.equal(classify({ title: "Naruto Episode 12" }, list).seriesSlug, "naruto");
  });

  test("two series matching with the same length is ambiguous -> pending", () => {
    const list = [
      { id: 1, slug: "hunter-x-hunter-2011", name: "Hunter x Hunter 2011", aliases: ["HxH"] },
      { id: 2, slug: "hunter-x-hunter-1999", name: "Hunter x Hunter 1999", aliases: ["HxH"] },
    ];
    const result = classify({ title: "HxH Episode 12" }, list);
    assert.equal(result.seriesSlug, null);
    assert.equal(result.status, "pending");
  });
});

describe("normalize()", () => {
  test("strips accents and punctuation", () => {
    assert.equal(normalize("Episódio 5 — Dublado!"), " episodio 5 dublado ");
  });
});

describe("parseYouTubeId()", () => {
  const ID = "dQw4w9WgXcQ";
  const valid = [
    ID,
    `  ${ID}  `,
    `https://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&list=PL123&index=2`,
    `https://youtube.com/watch?feature=share&v=${ID}`,
    `http://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=42`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}?rel=0`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/v/${ID}`,
  ];
  for (const input of valid) {
    test(`reads ${input.trim()}`, () => assert.equal(parseYouTubeId(input), ID));
  }

  const invalid = [
    "",
    null,
    "not a url",
    "dQw4w9WgXcQX", // 12 chars
    "https://vimeo.com/123456789",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/channel/UC1234567890",
    "https://evil.example/watch?v=dQw4w9WgXcQ",
  ];
  for (const input of invalid) {
    test(`rejects ${JSON.stringify(input)}`, () => assert.equal(parseYouTubeId(input), null));
  }
});

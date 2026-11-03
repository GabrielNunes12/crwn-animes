// Starting catalog, taken from the old src/anime-data.json mock (prices dropped,
// short synopses added).
// Series are not tied to a section: "One Piece" can have anime episodes and
// manga chapters. A series shows up under /anime or /manga once it has at
// least one published video there.
// `aliases` are the other names a YouTube title may use for the series.
export const SEED_SERIES = [
  {
    slug: "naruto-shippuden",
    synopsis:
      "Two and a half years after leaving the Hidden Leaf, Naruto returns stronger and sets out to rescue his friend Sasuke from the Akatsuki’s shadow.",
    name: "Naruto Shippuden",
    aliases: ["Naruto Shippuuden", "Naruto Shipuden"],
    genres: ["Shonen", "Adventure"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/7add01c632a7aaf883a90d75b0154ab8.jpeg",
  },
  {
    slug: "tokyo-ghoul",
    synopsis:
      "After a deadly encounter, college student Ken Kaneki becomes half-ghoul and must survive in a Tokyo where ghouls hunt humans and investigators hunt ghouls.",
    name: "Tokyo Ghoul",
    aliases: ["Tokyo Kushu"],
    genres: ["Drama", "Fantasy"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/95d654e35bbd2b8f972f2ccfe80df20b.jpeg",
  },
  {
    slug: "black-summoner",
    synopsis:
      "Reborn in another world after trading away his memories, Kelvin becomes a summoner whose loyal monsters grow stronger with every battle.",
    name: "Black Summoner",
    aliases: ["Kuro no Shoukanshi", "Kuro no Shokanshi"],
    genres: ["Fantasy", "Adventure"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/30c52b8f481041c3e629bbf67c90811e.jpeg",
  },
  {
    slug: "one-piece",
    synopsis:
      "Monkey D. Luffy and the Straw Hat crew sail the Grand Line in search of the legendary treasure that will make him King of the Pirates.",
    name: "One Piece",
    aliases: [],
    genres: ["Shonen", "Adventure", "Comedy"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/236f44583009506b8d9d012c4d3119a5.jpeg",
  },
  {
    slug: "jujutsu-kaisen",
    synopsis:
      "High schooler Yuji Itadori swallows a cursed finger and joins Jujutsu High to fight the curses born from human fear.",
    name: "Jujutsu Kaisen",
    aliases: ["JJK"],
    genres: ["Shonen", "Fantasy"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/98662d1c546c4e74de58fbc52679ac6c.jpeg",
  },
  {
    slug: "bleach",
    synopsis:
      "Teenager Ichigo Kurosaki gains the powers of a Soul Reaper and protects the living world from Hollows and the Soul Society’s secrets.",
    name: "Bleach",
    aliases: [],
    genres: ["Shonen", "Adventure"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/8ee28177b8ff7446c5b5539e3d57dfae.jpeg",
  },
  {
    slug: "chainsaw-man",
    synopsis:
      "Debt-ridden Denji merges with his chainsaw devil dog Pochita and becomes a devil hunter for Public Safety.",
    name: "Chainsaw Man",
    aliases: [],
    genres: ["Shonen", "Drama"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/ea075b926e1073f4eb016bff8cdb434c.jpeg",
  },
];

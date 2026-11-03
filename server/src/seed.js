// Starting catalog, taken from the old src/anime-data.json mock (prices dropped).
// Series are not tied to a section: "One Piece" can have anime episodes and
// manga chapters. A series shows up under /anime or /manga once it has at
// least one published video there.
// `aliases` are the other names a YouTube title may use for the series.
export const SEED_SERIES = [
  {
    slug: "naruto-shippuden",
    name: "Naruto Shippuden",
    aliases: ["Naruto Shippuuden", "Naruto Shipuden"],
    genres: ["Shonen", "Adventure"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/7add01c632a7aaf883a90d75b0154ab8.jpeg",
  },
  {
    slug: "tokyo-ghoul",
    name: "Tokyo Ghoul",
    aliases: ["Tokyo Kushu"],
    genres: ["Drama", "Fantasy"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/95d654e35bbd2b8f972f2ccfe80df20b.jpeg",
  },
  {
    slug: "black-summoner",
    name: "Black Summoner",
    aliases: ["Kuro no Shoukanshi", "Kuro no Shokanshi"],
    genres: ["Fantasy", "Adventure"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/30c52b8f481041c3e629bbf67c90811e.jpeg",
  },
  {
    slug: "one-piece",
    name: "One Piece",
    aliases: [],
    genres: ["Shonen", "Adventure", "Comedy"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/236f44583009506b8d9d012c4d3119a5.jpeg",
  },
  {
    slug: "jujutsu-kaisen",
    name: "Jujutsu Kaisen",
    aliases: ["JJK"],
    genres: ["Shonen", "Fantasy"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/98662d1c546c4e74de58fbc52679ac6c.jpeg",
  },
  {
    slug: "bleach",
    name: "Bleach",
    aliases: [],
    genres: ["Shonen", "Adventure"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/8ee28177b8ff7446c5b5539e3d57dfae.jpeg",
  },
  {
    slug: "chainsaw-man",
    name: "Chainsaw Man",
    aliases: [],
    genres: ["Shonen", "Drama"],
    coverUrl:
      "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/ea075b926e1073f4eb016bff8cdb434c.jpeg",
  },
];

// The admin series list reports published counts per section, so an admin can see which
// series are not on the site yet (a series only shows up in a section once it has a video there).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addVideo, signUp, startServer } from "./helpers.js";

let srv;
let admin;
before(async () => {
  srv = await startServer({ config: { adminEmails: ["admin@example.com"] } });
  admin = await signUp(srv, { email: "admin@example.com", displayName: "Boss" });
});
after(() => srv.close());

test("admin series items carry videoCounts per section (published only)", async () => {
  await addVideo(srv, 801, "Bleach Episode 1");
  await addVideo(srv, 802, "Bleach Episode 2");
  await addVideo(srv, 803, "Bleach Manga Chapter 1");
  await addVideo(srv, 804, "Bleach something without a number"); // pending: not counted
  const res = await admin.get("/api/admin/series?q=bleach");
  assert.equal(res.status, 200, res.text);
  const bleach = res.body.items.find((s) => s.slug === "bleach");
  assert.deepEqual(bleach.videoCounts, { anime: 2, manga: 1 });

  const all = await admin.get("/api/admin/series?limit=100");
  const tokyo = all.body.items.find((s) => s.slug === "tokyo-ghoul");
  assert.deepEqual(tokyo.videoCounts, { anime: 0, manga: 0 });
});

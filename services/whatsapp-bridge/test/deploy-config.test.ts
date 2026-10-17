/**
 * Deploy config for ffmpeg (voice notes plan, Task 4). Railway builds the
 * bridge with Nixpacks or Railpack depending on the service's age; each
 * builder reads only its own file, so both must ask for ffmpeg.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");

test("nixpacks.toml installs ffmpeg and keeps Nixpacks' default apt packages", () => {
  assert.match(read("nixpacks.toml"), /aptPkgs\s*=\s*\[\s*"\.\.\.",\s*"ffmpeg"\s*\]/);
});

test("railpack.json installs ffmpeg into the deploy image", () => {
  const config = JSON.parse(read("railpack.json")) as { deploy?: { aptPackages?: string[] } };
  assert.ok(config.deploy?.aptPackages?.includes("ffmpeg"));
});

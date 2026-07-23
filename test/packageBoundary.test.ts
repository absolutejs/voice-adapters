import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import rootPackage from "../package.json";

for (const workspace of rootPackage.workspaces) {
  test(`${workspace} uses the host's Voice runtime`, async () => {
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", workspace, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.["@absolutejs/voice"]).toBeUndefined();
    expect(packageJson.peerDependencies?.["@absolutejs/voice"]).toBe(
      ">=0.0.22-beta.644 <0.1",
    );
    expect(packageJson.devDependencies?.["@absolutejs/voice"]).toBe(
      "0.0.22-beta.644",
    );
  });
}

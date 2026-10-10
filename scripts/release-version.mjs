// The version a tag build ships, from one source: apps/desktop/package.json. CI runs this
// before `pnpm build` on a `v*` tag (.github/workflows/build.yml), so app.getVersion(),
// What's New (__APP_VERSION__) and the usage stats key (electron.vite.config.ts) agree.
//   node scripts/release-version.mjs <tag> [package.json]
// A release tag (v1.2.3) must equal package.json's version, which `pnpm release` bumps; the
// job fails otherwise. A prerelease tag (v1.2.3-beta.1) is tagged without a bump, so its
// version is written into package.json, in the CI workspace only. Prints the version.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What a tag build does with package.json's version: `{ version, write }`, where `write`
 * says package.json must take the tag's version first. Throws when a release tag and
 * package.json disagree, or the tag isn't `v<semver>`.
 * @param {string} tag
 * @param {string} pkgVersion
 * @returns {{ version: string, prerelease: boolean, write: boolean }}
 */
export function releaseVersion(tag, pkgVersion) {
  const version = tag.replace(/^refs\/tags\//, "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`${tag} isn't a release tag: tags look like v1.2.3 or v1.2.3-beta.1`);
  const prerelease = version.includes("-");
  if (prerelease) return { version, prerelease, write: version !== pkgVersion };
  if (version !== pkgVersion)
    throw new Error(`${tag} doesn't match apps/desktop/package.json (${pkgVersion}). Tag releases with pnpm release, which bumps it first.`);
  return { version, prerelease, write: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [tag, file = fileURLToPath(new URL("../apps/desktop/package.json", import.meta.url))] = process.argv.slice(2);
  if (!tag) {
    console.error("usage: node scripts/release-version.mjs <tag> [package.json]");
    process.exit(1);
  }
  const text = fs.readFileSync(file, "utf8");
  const pkg = JSON.parse(text);
  try {
    const { version, write } = releaseVersion(tag, pkg.version);
    if (write) {
      fs.writeFileSync(file, text.replace(/("version"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(version)}`));
      if (JSON.parse(fs.readFileSync(file, "utf8")).version !== version) throw new Error(`couldn't write ${version} into ${file}`);
      console.log(`${version} (prerelease, written into package.json for this build)`);
    } else console.log(version);
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

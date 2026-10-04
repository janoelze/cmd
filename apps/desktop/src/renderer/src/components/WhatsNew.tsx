// The What's New sheet: CHANGELOG.md's releases, bundled at build time. Opens by
// itself after an update with the releases since the version the app last ran
// as (main/whats-new.ts), and from Help → What's New / the status bar's
// sparkles with every release.

import { Badge, Button, Dialog, type Tone } from "@cmd/ui";
import { Fragment, type ReactNode } from "react";
import changelog from "../../../../../../CHANGELOG.md?raw";
import { compareVersions, parseChangelog, releasesBetween, type ChangeKind, type Release } from "../../../shared/changelog.ts";

declare const __APP_VERSION__: string;

export const RELEASES: Release[] = parseChangelog(changelog);

/** The version this build is, from the app's package.json via Vite. */
export const APP_VERSION: string = __APP_VERSION__;

/** What an automatic open shows: releases after `after` (null: the newest one up to this version). */
export function releasesSince(after: string | null): Release[] {
  const upTo = RELEASES.filter((r) => compareVersions(r.version, APP_VERSION) <= 0);
  return after === null ? upTo.slice(0, 1) : releasesBetween(upTo, after, APP_VERSION);
}

const TONE: Record<ChangeKind, Tone> = { New: "accent", Improved: "success", Fixed: "warning", Removed: "neutral" };

/** `**bold**`, `` `code` `` and `[links](url)`: all the Markdown an entry may use. */
function inline(text: string, onLink: (url: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m; (m = re.exec(text)); last = re.lastIndex) {
    out.push(text.slice(last, m.index));
    const [, bold, code, label, url] = m;
    if (bold) out.push(<strong key={m.index}>{bold}</strong>);
    else if (code) out.push(<code key={m.index}>{code}</code>);
    else
      out.push(
        <a key={m.index} href={url} onClick={(e) => (e.preventDefault(), onLink(url!))}>
          {label}
        </a>,
      );
  }
  out.push(text.slice(last));
  return out;
}

export function WhatsNew({ releases, onClose, onLink }: { releases: Release[]; onClose: () => void; onLink: (url: string) => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="What's New"
      width={560}
      className="whats-new"
      actions={
        <>
          <span className="whats-new-version">You're on cmd {APP_VERSION}</span>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="whats-new-list">
        {releases.length === 0 && <div className="whats-new-empty">No release notes for this version.</div>}
        {releases.map((r) => (
          <section key={r.version} className="whats-new-release">
            <header>
              <h3>{r.version}</h3>
              <time dateTime={r.date}>{formatDate(r.date)}</time>
            </header>
            {r.summary && <p className="whats-new-summary">{inline(r.summary, onLink)}</p>}
            {r.sections.map((s) => (
              <Fragment key={s.kind}>
                <Badge size="sm" tone={TONE[s.kind]}>
                  {s.kind}
                </Badge>
                <ul>
                  {s.entries.map((e, i) => (
                    <li key={i}>{inline(e, onLink)}</li>
                  ))}
                </ul>
              </Fragment>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}

const formatDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

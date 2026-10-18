// The screens before a Mac is connected: Add a Mac (scan the Mac's code with
// the camera, or paste its link), the camera itself, and a pairing link opened
// in the browser, which waits for a tap and suggests installing the app first
// (install.ts).

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Icon, TextField } from "@cmd/ui";
import { installHintHere, onInstallChange, promptInstall, type InstallHint } from "./install.ts";
import { elsewhere, pairingFragment, qrDecoder } from "./scan.ts";
import { Center } from "./ui.tsx";

const NOT_A_LINK = "That isn't a cmd pairing link. Use Copy Link in Settings → Remote Access on your Mac.";

/** Pair a Mac: Scan Code, or Paste Link where there's no camera. */
export function AddMac({ title, onPair, onCancel }: { title: string; onPair: (fragment: string) => void; onCancel?: () => void }) {
  const [scanning, setScanning] = useState(false);
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  /** A code for another client (another Mac's own address): opened there, not paired here. */
  const [there, setThere] = useState<string | null>(null);

  /** A scanned or pasted pairing link: paired here, or sent to the client it was made for. */
  const take = (link: string, fragment: string) => {
    const origin = elsewhere(link, location.origin);
    if (!origin) return onPair(fragment);
    setThere(link.trim());
    setNote(`This code is for cmd at ${new URL(origin).host}, so it pairs there.`);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const f = pairingFragment(text);
    if (f) take(text, f);
    else (setThere(null), setNote(NOT_A_LINK));
  };

  if (scanning)
    return (
      <Scanner
        onFound={(link, f) => (setScanning(false), take(link, f))}
        onClose={(why) => {
          setScanning(false);
          if (why) (setNote(why), setPaste(true));
        }}
      />
    );
  return (
    <Center
      icon="qr-code"
      title={title}
      action={
        <div className="pair-actions">
          <Button size="lg" variant="primary" icon="qr-code" onClick={() => (setNote(null), setThere(null), setScanning(true))}>
            Scan Code
          </Button>
          {paste ? (
            <form className="paste" onSubmit={submit}>
              <TextField
                size="lg"
                fill
                type="url"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Pairing link"
                aria-label="Pairing link"
                value={text}
                onChange={(v) => (setText(v), setNote(null), setThere(null))}
              />
              <Button size="lg" type="submit" disabled={!text.trim()}>
                Pair
              </Button>
            </form>
          ) : (
            <Button size="lg" variant="ghost" icon="clipboard-text" onClick={() => setPaste(true)}>
              Paste Link
            </Button>
          )}
          {note && <p className="note">{note}</p>}
          {there && (
            <Button size="lg" onClick={() => location.assign(there)}>
              Open There
            </Button>
          )}
          {onCancel && (
            <Button size="lg" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      }
    >
      On your Mac, open cmd → Settings → Remote Access and scan the code it shows.
    </Center>
  );
}

type CameraState = { kind: "starting" } | { kind: "scanning"; wrong: boolean };

/** How often a frame is decoded, in ms. */
const EVERY = 150;

/**
 * The rear camera, decoding a frame every EVERY ms until it sees a cmd pairing
 * code. A code that isn't cmd's says so and keeps scanning. Closes with why
 * when there's no camera to use. The tracks stop on success, close and unmount.
 */
function Scanner({ onFound, onClose }: { onFound: (link: string, fragment: string) => void; onClose: (why?: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CameraState>({ kind: "starting" });
  const found = useRef(onFound);
  const close = useRef(onClose);
  found.current = onFound;
  close.current = onClose;

  useEffect(() => {
    let live = true;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wrongUntil = 0;
    const stop = () => {
      live = false;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return close.current("No camera here. Paste the link instead, from Copy Link on your Mac.");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch (e) {
        const denied = (e as DOMException).name === "NotAllowedError";
        if (live)
          close.current(
            denied
              ? "cmd can't use the camera. Allow it in your browser's settings, or paste the link instead."
              : "No camera here. Paste the link instead, from Copy Link on your Mac.",
          );
        return;
      }
      if (!live) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});
      const decode = await qrDecoder();
      if (!live) return;
      setState({ kind: "scanning", wrong: false });
      const tick = async () => {
        if (!live) return;
        const text = v.readyState >= 2 ? await decode(v).catch(() => null) : null;
        if (!live) return;
        const fragment = text ? pairingFragment(text) : null;
        if (text && fragment) return stop(), found.current(text, fragment);
        if (text) wrongUntil = Date.now() + 3000;
        setState({ kind: "scanning", wrong: Date.now() < wrongUntil });
        timer = setTimeout(() => void tick(), EVERY);
      };
      void tick();
    })();
    return stop;
  }, []);

  const hint =
    state.kind === "starting"
      ? "Starting the camera…"
      : state.wrong
        ? "That isn't a cmd code. Scan the one in Settings → Remote Access on your Mac."
        : "Point the camera at the code on your Mac.";
  return (
    <div className="scanner">
      <video ref={video} playsInline muted autoPlay />
      <div className="scanner-frame" />
      <div className="scanner-bar">
        <div className={state.kind === "scanning" && state.wrong ? "scanner-hint wrong" : "scanner-hint"} role="status">
          {hint}
        </div>
        <Button size="lg" onClick={() => onClose()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * A pairing link, in any browser: pairs only when the person taps Pair This
 * Browser. Where installing makes sense it's offered as the other choice: on
 * iOS the Home Screen steps (the app pairs with its own scan), in Chromium the
 * browser's install prompt (its app keeps this pairing).
 */
export function PairLink({ onPair }: { onPair: () => void }) {
  const [hint, setHint] = useState<InstallHint>(installHintHere);
  useEffect(() => onInstallChange(() => setHint(installHintHere())), []);
  const pair = (
    <Button size="lg" variant="primary" onClick={onPair}>
      Pair This Browser
    </Button>
  );
  if (!hint)
    return (
      <Center icon="lock" title="Pair with Your Mac" action={pair}>
        Your Mac asks you to allow it.
      </Center>
    );
  return (
    <Center
      icon="lock"
      title="Pair with Your Mac"
      action={
        <div className="choices">
          <section className="choice">
            <h2>{hint === "ios" ? `In ${iosBrowser()}` : "In This Browser"}</h2>
            <p>Your Mac asks you to allow it.</p>
            {pair}
          </section>
          {hint === "ios" ? (
            <section className="choice">
              <h2>As an App on Your Home Screen</h2>
              <ol className="steps">
                <li>
                  Tap Share <Icon name="export" size={15} />, then Add to Home Screen.
                </li>
                <li>Open cmd from your Home Screen.</li>
                <li>Tap Scan Code and scan the code on your Mac again.</li>
              </ol>
            </section>
          ) : (
            <section className="choice">
              <h2>As an App</h2>
              <p>Pair here first: the app keeps the pairing.</p>
              <Button size="lg" onClick={() => void promptInstall()}>
                Install App
              </Button>
            </section>
          )}
        </div>
      }
    >
      Where do you want to use cmd?
    </Center>
  );
}

/** Safari, unless the UA names another iOS browser (they all run WebKit but are their own apps). */
const iosBrowser = () => (/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent) ? "This Browser" : "Safari");

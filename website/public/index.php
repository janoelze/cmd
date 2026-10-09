<?php
// endtime-instruments.org/cmd: the product page and the list of releases from
// GitHub (lib/releases.php). Copy follows docs/15-positioning.md; the feature
// grid comes from _lib/features.json, which the release skill keeps current.

declare(strict_types=1);
require __DIR__ . '/_lib/releases.php';
require __DIR__ . '/_lib/layout.php';

/** The feature grid: [{title, text, badge?}]. */
function features(): array
{
    return json_decode((string) file_get_contents(__DIR__ . '/_lib/features.json'), true, 8, JSON_THROW_ON_ERROR)['features'];
}

/** Escapes $s and renders its `code` spans as <code> and shortcuts (⇧⌘F, ⌘-click) as <kbd>. */
function rich(string $s): string
{
    $s = preg_replace('/`([^`]+)`/', '<code>$1</code>', h($s));
    return preg_replace('/[⌃⌥⇧⌘]+(?:[A-Z0-9,↩↑↓←→]|(?=-))/u', '<kbd>$0</kbd>', $s);
}

$releases = releases();
$latest = null;
foreach ($releases as $r) {
    if (!$r['prerelease']) {
        $latest = $r;
        break;
    }
}

page_start('cmd for macOS — spaces that work', 'A software workbench for macOS. Terminals, coding agents, browser, editor and widgets, side by side in one Space per project, arranged however you work.', '');
?>
<h1>cmd</h1>
<p class="lede">A software workbench for macOS. Terminals, coding agents, browser, editor and widgets, side by side in one Space per project, arranged however you work.</p>
<p class="cta">
<?php if ($latest): ?>
  <a class="button" href="<?= h($latest['dmg'] ?? $latest['url']) ?>">Download <?= h($latest['tag']) ?></a>
<?php endif ?>
  <a class="button secondary" href="https://github.com/janoelze/cmd">View on GitHub</a>
  <span class="muted">For Macs with Apple silicon</span>
</p>

<div class="hero-shots" aria-roledescription="slideshow">
  <img class="on" src="shots/strip.png" width="1498" height="898" alt="The strip: a Claude Code session, a shader widget, the file browser and a CI widget; four agents in the sidebar">
  <img src="shots/grid-dark.png" width="1498" height="898" alt="The grid: usage and CI widgets, four Claude Code sessions, a shader, the file browser and a shell">
  <img src="shots/light-agents.png" width="1498" height="898" alt="A light theme: a Claude Code session, the Agent Activity widget and a CI widget">
  <img src="shots/usage.png" width="1498" height="898" alt="The usage widget, a Claude Code session and a shader widget in the strip">
  <img src="shots/search.png" width="1498" height="898" alt="Searching files from the palette: json files and matching lines across the repo">
  <img src="shots/light-files.png" width="1498" height="898" alt="A light theme: the file browser on the repo next to a CI widget">
  <img src="shots/canvas-shader.png" width="1498" height="898" alt="The canvas: a shader widget and the file browser">
  <img src="shots/strip-agents.png" width="1498" height="898" alt="The strip: two Claude Code sessions side by side with a CI widget">
  <img src="shots/weather.png" width="1498" height="898" alt="A weather widget next to a Claude Code session, in a warm theme">
  <img src="shots/light-palette.png" width="1498" height="898" alt="The command palette over the canvas, in a light theme">
  <img src="shots/json.png" width="1498" height="898" alt="A JSON window on package.json next to the Navigator and a CI widget">
  <img src="shots/search-shader.png" width="1498" height="898" alt="File search over the canvas, with a shader widget behind">
  <img src="shots/empty.png" width="1498" height="898" alt="An empty workspace: recent sessions in the sidebar and a hint to press ⌘N">
</div>
<script>
// Shuffle the hero screenshots, fade the gallery in once the first has loaded,
// then crossfade through them; reduced motion shows one at random. Without
// script the first one shows.
(() => {
  const box = document.querySelector(".hero-shots");
  const shots = [...box.children];
  for (let i = shots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shots[i], shots[j]] = [shots[j], shots[i]];
  }
  for (const s of shots) { s.classList.remove("on"); box.append(s); }
  shots[0].classList.add("on");
  // Hidden until the first screenshot has loaded, then faded in; the
  // crossfade starts from there.
  const cycle = shots.length > 1 && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  let shown = false;
  const reveal = () => {
    if (shown) return;
    shown = true;
    box.classList.remove("loading");
    if (!cycle) return;
    let i = 0;
    setInterval(() => {
      if (document.hidden) return;
      shots[i].classList.remove("on");
      i = (i + 1) % shots.length;
      shots[i].classList.add("on");
    }, 3500);
  };
  box.classList.add("loading");
  shots[0].decode().then(reveal, reveal);
  setTimeout(reveal, 3000);
})();
</script>

<section class="why">
<h2>Why I'm building this</h2>
<div class="cols">
<p>For better or worse, I'm going to spend the rest of my working life in terminals. That's where my work happens, and it isn't changing soon. What struck me is how little my terminal workflow had kept up: <strong>forty tabs with a Claude Code session in each</strong>, flipping between them all day, discovering finished sessions only by accident. So I wanted a software workbench that <strong>embraces UNIX at its core</strong>, shells, pipes, <code>open</code>, the tools I already have, and gives me a more accessible view of what's happening in them.</p>
<p>cmd is that workbench. <strong>A Space per project</strong> holds everything I'm working on. Its main view is <strong>a strip, inspired by PaperWM</strong>: windows side by side in a row I scroll along, which turns out to be a natural way to keep a few terminals, an agent and a browser in sight at once. cmd knows which terminals have an agent in them and what each is doing, and <strong>keeps the one that needs me on top</strong>.</p>
<p><strong>Most of what I open stays inside.</strong> <code>open</code> a file in a shell and it appears in the Space, in a window that knows the type: text, Markdown, JSON, a URL in the browser.</p>
<p>With <strong>Magic widgets</strong>, a built-in agent that makes new widgets as I ask for them, I describe what I want to see: my open merge requests, the depth of a queue, the last CI runs, a calculator. It writes a small widget for it, one that follows whichever theme I switch to, on top of the tools already on my machine, <code>gh</code>, <code>kubectl</code>, <code>curl</code>, a script in the repo.</p>
<p><strong>This isn't an agent orchestrator.</strong> Those come with a workflow of their own, and the workflow tends to go stale with the next model. cmd doesn't assume one. <strong>It bets on terminals</strong>, and terminals will still be here when the next model arrives. I'm building it for my own day, in the open, hoping it fits yours too.</p>
</div>
</section>

<hr>

<div class="features">
<?php foreach (features() as $f): ?>
  <div><h3><?= h($f['title']) ?><?php if (isset($f['badge'])): ?> <span class="pill"><?= h($f['badge']) ?></span><?php endif ?></h3><p><?= rich($f['text']) ?></p></div>
<?php endforeach ?>
</div>

<h2>Releases</h2>
<?php if (!$releases): ?>
<p class="muted">The release list is unavailable right now. See <a href="https://github.com/janoelze/cmd/releases">GitHub</a>.</p>
<?php else: ?>
<ol class="releases">
<?php foreach (array_slice($releases, 0, 6) as $r): ?>
  <li<?= $r === $latest ? ' class="latest"' : '' ?>>
    <a class="tag" href="<?= h($r['url']) ?>"><?= h($r['tag']) ?></a>
    <span class="badges"><?= $r === $latest ? '<span class="pill accent">Latest</span>' : '' ?><?= $r['prerelease'] ? '<span class="pill">Pre-release</span>' : '' ?></span>
    <time datetime="<?= h($r['published']) ?>"><?= h($r['date']) ?></time>
    <span class="size"><?= $r['size'] ? h(number_format($r['size'] / 1048576)) . ' MB' : '' ?></span>
    <?php if ($r['dmg']): ?><a class="button secondary small" href="<?= h($r['dmg']) ?>">Download</a><?php else: ?><span></span><?php endif ?>
  </li>
<?php endforeach ?>
</ol>
<p class="more"><a href="https://github.com/janoelze/cmd/releases">All <?= count($releases) ?> releases on GitHub →</a></p>
<script>
// Release times in the reader's time zone ("Oct 4, 22:58").
for (const t of document.querySelectorAll(".releases time")) {
  const d = new Date(t.dateTime);
  if (!isNaN(d)) t.textContent = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
</script>
<?php endif ?>
<?php
page_end();

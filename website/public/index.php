<?php
// endtime-instruments.org/cmd: the product page and the list of releases from
// GitHub (lib/releases.php). Copy follows docs/15-positioning.md.

declare(strict_types=1);
require __DIR__ . '/_lib/releases.php';
require __DIR__ . '/_lib/layout.php';

$releases = releases();
$latest = null;
foreach ($releases as $r) {
    if (!$r['prerelease']) {
        $latest = $r;
        break;
    }
}

page_start('cmd — terminals and coding agents, side by side', 'A macOS app for running terminals and coding agents side by side, with web and file browsers, an editor and widgets an agent builds live.', '');
?>
<h1>cmd</h1>
<p class="lede">A macOS app for running terminals and coding agents side by side, with web and file browsers, an editor, and widgets an agent builds live when you ask.</p>
<p class="cta">
<?php if ($latest): ?>
  <a class="button" href="<?= h($latest['dmg'] ?? $latest['url']) ?>">Download <?= h($latest['tag']) ?></a>
<?php endif ?>
  <a class="button secondary" href="https://github.com/janoelze/cmd">View on GitHub</a>
  <span class="muted">For Macs with Apple silicon</span>
</p>

<div class="hero-shots" aria-roledescription="slideshow">
  <img class="on" src="assets/hero.png" width="1505" height="950" alt="cmd with a usage widget, a Claude Code session finishing a release, and a CI widget side by side; six agents in the sidebar">
  <img src="assets/theme-slate.png" width="1505" height="950" alt="The strip in a slate theme: a Claude Code session, a CI widget and another session">
  <img src="assets/grid.png" width="1505" height="950" alt="The grid: twelve windows at once, agents, widgets, a file browser, a shell and the weather">
  <img src="assets/agents.png" width="1505" height="950" alt="The strip: a Claude Code session, a file browser and a shell, with six agents and recent sessions in the sidebar">
  <img src="assets/theme-warm.png" width="1505" height="950" alt="The canvas in a warm theme: a shader widget next to top">
  <img src="assets/widgets.png" width="1505" height="950" alt="A weather widget next to top in the strip">
  <img src="assets/canvas-pan.png" width="1505" height="950" alt="The canvas, panned across a log, a usage widget and a Claude Code session">
</div>
<script>
// Shuffle the hero screenshots, then crossfade through them; reduced motion
// shows one at random. Without script the first one shows.
(() => {
  const box = document.querySelector(".hero-shots");
  const shots = [...box.children];
  for (let i = shots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shots[i], shots[j]] = [shots[j], shots[i]];
  }
  for (const s of shots) { s.classList.remove("on"); box.append(s); }
  shots[0].classList.add("on");
  if (shots.length < 2 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let i = 0;
  setInterval(() => {
    if (document.hidden) return;
    shots[i].classList.remove("on");
    i = (i + 1) % shots.length;
    shots[i].classList.add("on");
  }, 3500);
})();
</script>

<div class="features">
  <div><h3>Layouts</h3><p>Focus on one window, tile them in a grid, scroll through a strip, or place them on an infinite canvas with a minimap.</p></div>
  <div><h3>Agent detection</h3><p>Claude Code, Codex, Gemini, Aider and others are recognised in any terminal, even behind wrappers and sandboxes.</p></div>
  <div><h3>Waiting agents first</h3><p>Agents waiting for input are listed first, then working, then done. ⌃⌘J jumps to the next one.</p></div>
  <div><h3>Remote access</h3><p>Pair a phone or another browser with a QR code and use your terminals and agents on the go, end-to-end encrypted. In preview.</p></div>
  <div><h3>Terminals keep running</h3><p>A background process owns them, so quitting, reloading or updating the app doesn't end them.</p></div>
  <div><h3>Session search</h3><p>Full-text search over Claude Code, Codex, Qwen Code and Copilot CLI transcripts. Return resumes a session.</p></div>
  <div><h3>Magic widgets</h3><p>Describe what to show and an agent builds a live widget for it. Change it by asking. Uses your own API key.</p></div>
  <div><h3>Web browser</h3><p>Next to your terminals, with phone, tablet and desktop sizes.</p></div>
  <div><h3>Files and editor</h3><p>A file browser, a text editor and Markdown windows. <code>open</code> in a shell opens files in cmd.</p></div>
  <div><h3>Notifications</h3><p>Waiting agents, bells, finished commands and OSC 9/777/99 mark the terminal until you look, and count on the Dock badge.</p></div>
  <div><h3>Keyboard first</h3><p>⌘K finds windows, commands and past sessions. Every action is in the menu bar, and every shortcut can be remapped.</p></div>
  <div><h3>CLI</h3><p><code>cmd</code> spawns, messages, waits on and stops agents, so an agent can run other agents.</p></div>
  <div><h3>A complete terminal</h3><p>Find in scrollback, jump between prompts, inline images, OSC 52 copy over ssh, a check before risky pastes.</p></div>
  <div><h3>Themes</h3><p>16 themes, light and dark, following the system or not.</p></div>
  <div><h3>Updates</h3><p>Signed and notarized. Updates install when you quit, and terminals keep running.</p></div>
</div>

<h2 class="section">Releases</h2>
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

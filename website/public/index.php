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

page_start('cmd — terminals and coding agents, side by side', 'A macOS app for running terminals and coding agents side by side, in a grid, a strip or on a canvas.', '');
?>
<h1>cmd</h1>
<p class="lede">A macOS app for running terminals and coding agents side by side.</p>
<p class="cta">
<?php if ($latest): ?>
  <a class="button" href="<?= h($latest['dmg'] ?? $latest['url']) ?>">Download <?= h($latest['tag']) ?></a>
<?php endif ?>
  <a class="button secondary" href="https://github.com/janoelze/cmd">View on GitHub</a>
  <span class="muted">For Macs with Apple silicon</span>
</p>

<div class="hero-shots" aria-roledescription="slideshow">
  <img class="on" src="assets/hero.png" width="1505" height="950" alt="cmd with a usage widget, a Claude Code session finishing a release, and a CI widget side by side; six agents in the sidebar">
  <img src="assets/grid.png" width="1505" height="950" alt="The grid: twelve windows at once, agents, widgets, a file browser, a shell and the weather">
  <img src="assets/agents.png" width="1505" height="950" alt="The strip: a Claude Code session, a file browser and a shell, with six agents and recent sessions in the sidebar">
  <img src="assets/widgets.png" width="1505" height="950" alt="A weather widget next to top in the strip">
  <img src="assets/canvas.png" width="1505" height="950" alt="The canvas: a widget and a Claude Code session placed freely">
  <img src="assets/canvas-pan.png" width="1505" height="950" alt="The canvas, panned across a log, a usage widget and a Claude Code session">
</div>
<script>
// Crossfade the hero screenshots; reduced motion keeps the first.
(() => {
  const shots = document.querySelectorAll(".hero-shots img");
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

<p>Terminals, Claude Code and Codex sessions, browsers, editors and widgets are all windows in one app. It isn't an IDE and has no agent of its own: you bring Claude Code, Codex or whichever agent you use.</p>

<section class="pillar">
  <h2>Layouts</h2>
  <p>Show one window at a time, tile them in a grid, scroll through them in a strip, or place them on a canvas. ⌘K finds any window, command or past session.</p>
  <img class="shot" src="assets/grid.png" width="1505" height="950" loading="lazy" alt="The grid: twelve windows at once, agents, widgets, a file browser, a shell and the weather">
</section>

<section class="pillar">
  <h2>Agents</h2>
  <p>cmd detects Claude Code, Codex and other agents in any terminal and lists the ones waiting for input first. Terminals run in a background process, so quitting or updating the app doesn't end them. Past sessions are searchable and can be resumed.</p>
  <img class="shot" src="assets/agents.png" width="1505" height="950" loading="lazy" alt="The strip: a Claude Code session, a file browser and a shell, with six agents and recent sessions in the sidebar">
</section>

<section class="pillar">
  <h2>Magic widgets</h2>
  <p>Describe what you want to see, like your CI runs or a JSON URL, and an agent writes a small widget that shows it and keeps it up to date. Uses your own Anthropic or OpenAI API key.</p>
  <img class="shot" src="assets/widgets.png" width="1505" height="950" loading="lazy" alt="A weather widget next to top in the strip">
</section>

<h2>Releases</h2>
<?php if (!$releases): ?>
<p class="muted">The release list is unavailable right now. See <a href="https://github.com/janoelze/cmd/releases">GitHub</a>.</p>
<?php else: ?>
<table>
  <tr><th>Version</th><th>Date</th><th></th></tr>
<?php foreach ($releases as $r): ?>
  <tr>
    <td><a class="tag" href="<?= h($r['url']) ?>"><?= h($r['tag']) ?></a><?= $r['prerelease'] ? '<span class="pill">pre-release</span>' : '' ?></td>
    <td class="num"><?= h($r['date']) ?></td>
    <td><?= $r['dmg'] ? '<a href="' . h($r['dmg']) . '">.dmg</a>' : '' ?></td>
  </tr>
<?php endforeach ?>
</table>
<?php endif ?>
<?php
page_end();

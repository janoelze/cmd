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

page_start('cmd — a workbench for building software with AI', 'Terminals, coding agents, a browser, an editor and widgets you make by asking, side by side on one desk. For macOS.', '');
?>
<h1>cmd</h1>
<p class="lede">A workbench for building software with AI. Terminals, coding agents, a browser, an editor and widgets you make by asking, side by side on one desk. Nothing gets lost, nothing dies, and the agent that needs you is always on top.</p>
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

<p>Terminals are where we'll work with agents for years to come, and they still feel like 1995: a window and a row of tabs. cmd is a desk instead. It isn't an IDE and it doesn't bring its own agent: you keep your editor and Claude Code or Codex, and cmd gives them a place to live. It's made for the serious, normal work, not for running 600 agents overnight.</p>

<section class="pillar">
  <h2>One desk</h2>
  <p>Terminals, agents, browser, editor and widgets are windows on the same desk. Focus on one, tile them in a grid, scroll through a strip, or lay them out on an infinite canvas. ⌘K finds anything.</p>
  <img class="shot" src="assets/grid.png" width="1505" height="950" loading="lazy" alt="The grid: twelve windows at once, agents, widgets, a file browser, a shell and the weather">
</section>

<section class="pillar">
  <h2>Knows your agents</h2>
  <p>Claude Code, Codex and others are recognised in any terminal. The one waiting for you is on top. Terminals survive quits and updates, and every past session is searchable and resumable.</p>
  <img class="shot" src="assets/agents.png" width="1505" height="950" loading="lazy" alt="The strip: a Claude Code session, a file browser and a shell, with six agents and recent sessions in the sidebar">
</section>

<section class="pillar">
  <h2>Magic widgets</h2>
  <p>Ask for a window: “the last CI runs”, “my open merge requests”, a JSON URL. An agent builds a live widget for it, in your theme. Close it tomorrow.</p>
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

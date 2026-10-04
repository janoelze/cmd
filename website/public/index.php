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
<?php if ($latest): ?>
<p><a class="button" href="<?= h($latest['dmg'] ?? $latest['url']) ?>">Download <?= h($latest['tag']) ?></a> <span class="muted">for Macs with Apple silicon</span></p>
<?php endif ?>

<p>Terminals are where we'll work with agents for years to come, and they still feel like 1995: a window and a row of tabs. cmd is a desk instead. It isn't an IDE and it doesn't bring its own agent: you keep your editor and Claude Code or Codex, and cmd gives them a place to live. It's made for the serious, normal work, not for running 600 agents overnight.</p>

<div class="pillars">
  <div class="card">
    <h2>One desk</h2>
    <p>Terminals, agents, browser, editor and widgets are windows on the same desk. Focus on one, tile them in a grid, scroll through a strip, or lay them out on an infinite canvas. ⌘K finds anything.</p>
  </div>
  <div class="card">
    <h2>Knows your agents</h2>
    <p>Claude Code, Codex and others are recognised in any terminal. The one waiting for you is on top. Terminals survive quits and updates, and every past session is searchable and resumable.</p>
  </div>
  <div class="card">
    <h2>Magic widgets</h2>
    <p>Ask for a window: “the last CI runs”, “my open merge requests”, a JSON URL. An agent builds a live widget for it, in your theme. Close it tomorrow.</p>
  </div>
</div>

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

<?php
// endtime-instruments.org/cmd: the product page (a placeholder for now) and the
// list of releases from GitHub (lib/releases.php).

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

page_start('cmd', 'A terminal and coding-agent workbench for macOS.', '');
?>
<h1>cmd</h1>
<p class="lede">A terminal and coding-agent workbench for macOS: terminals that survive restarts, an agent-aware sidebar, transcript search, spaces and a canvas. More here soon.</p>
<?php if ($latest): ?>
<p><a class="button" href="<?= h($latest['dmg'] ?? $latest['url']) ?>">Download <?= h($latest['tag']) ?></a> <span class="muted">for Macs with Apple silicon</span></p>
<?php endif ?>

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

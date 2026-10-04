<?php
// The public usage page: totals of what cmd sends (packages/core/src/usage.ts)
// over the last 30 days. ?format=json gives the same numbers as JSON.

declare(strict_types=1);
require __DIR__ . '/../../lib/db.php';
require __DIR__ . '/../../lib/layout.php';

$s = summary(30);
if (($_GET['format'] ?? '') === 'json') {
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    echo json_encode($s, JSON_PRETTY_PRINT);
    exit;
}

$macos = [];
foreach ($s['macos'] as $k => $n) $macos[$k === 'other' ? 'other' : "macOS $k"] = $n;
$maxDaily = max($s['daily']) ?: 1;

page_start('cmd usage', 'Anonymous usage stats of cmd, public.', 'usage/');
?>
<h1>Usage</h1>
<p class="lede">cmd counts a few things and sends the counts here once a minute: app launches, windows opened by type and agents started by kind, with the app version, macOS version, processor type and a random id per install. Never commands, paths, titles, anything typed or where you are. Turn it off in Settings → About.</p>

<div class="tiles">
  <div class="card tile"><div class="label">Active today</div><div class="value"><?= number_format($s['activeToday']) ?></div></div>
  <div class="card tile"><div class="label">Active, 7 days</div><div class="value"><?= number_format($s['active7']) ?></div></div>
  <div class="card tile"><div class="label">Active, 30 days</div><div class="value"><?= number_format($s['active30']) ?></div></div>
  <div class="card tile"><div class="label">Launches, 30 days</div><div class="value"><?= number_format($s['launches']) ?></div></div>
</div>

<h2>Active installs per day</h2>
<div class="card">
  <div class="daily" role="img" aria-label="Active installs per day, <?= h($s['from']) ?> to <?= h($s['to']) ?>">
<?php foreach ($s['daily'] as $day => $n): ?>
    <div class="col" title="<?= h("$day: $n") ?>"><span style="height:<?= round($n / $maxDaily * 100, 1) ?>%"></span></div>
<?php endforeach ?>
  </div>
  <div class="axis"><span><?= h($s['from']) ?></span><span>peak <?= number_format(max($s['daily'])) ?></span><span><?= h($s['to']) ?></span></div>
</div>

<div class="grid2">
  <div><h2>Windows opened, 30 days</h2><div class="card"><?php bars($s['windows']) ?></div></div>
  <div><h2>Agents started, 30 days</h2><div class="card"><?php bars($s['agents']) ?></div></div>
  <div><h2>Versions, installs active in 7 days</h2><div class="card"><?php bars($s['versions']) ?></div></div>
  <div><h2>macOS, installs active in 30 days</h2><div class="card"><?php bars($macos) ?></div></div>
  <div><h2>Processor</h2><div class="card"><?php bars($s['arch']) ?></div></div>
</div>

<p class="muted" style="margin-top:24px">Days are UTC. <?= number_format($s['installs']) ?> installs seen in total. <a href="?format=json">JSON</a></p>
<?php
page_end();

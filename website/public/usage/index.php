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
<p class="lede">cmd counts a few things and sends the counts here once a minute: app launches, windows opened by type, agents started by kind and crashes by process, with the app version, macOS version, processor type and a random id per install. Never commands, paths, titles, anything typed or where you are. Turn it off in Settings → About.</p>

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
  <div><h2>Crashes by process, 30 days</h2><div class="card"><?php bars($s['crashes'], 'None.') ?></div></div>
</div>

<h2>Release health, 30 days</h2>
<div class="card" style="overflow-x:auto">
<?php if (!$s['health']): ?>
  <p class="muted">Nothing yet.</p>
<?php else: ?>
  <table>
    <tr><th>Version</th><th>Installs</th><th>Launches</th><th>Crashes</th><th>Per 100 launches</th><th>Installs with a crash</th><th>Internal errors</th></tr>
<?php foreach ($s['health'] as $r): ?>
    <tr>
      <td class="tag"><?= h($r['version']) ?></td>
      <td class="num"><?= number_format($r['installs']) ?></td>
      <td class="num"><?= number_format($r['launches']) ?></td>
      <td class="num"><?= number_format($r['crashes']) ?></td>
      <td class="num"><?= $r['launches'] ? number_format($r['crashes'] / $r['launches'] * 100, 1) : '–' ?></td>
      <td class="num"><?= $r['installs'] ? round($r['crashedInstalls'] / $r['installs'] * 100) . '%' : '–' ?></td>
      <td class="num"><?= number_format($r['errors']) ?></td>
    </tr>
<?php endforeach ?>
  </table>
<?php endif ?>
</div>

<p class="muted" style="margin-top:24px">Crashes are when a process died or a window went blank; internal errors are ones cmd caught and kept running. A crash is counted with the version that reports it, usually the one that crashed. Days are UTC. <?= number_format($s['installs']) ?> installs seen in total. <a href="?format=json">JSON</a></p>
<?php
page_end();

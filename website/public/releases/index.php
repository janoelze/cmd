<?php
// The releases page: every version's notes from CHANGELOG.md (_lib/changelog.php),
// with its download from GitHub (_lib/releases.php) once CI has published it.

declare(strict_types=1);
require __DIR__ . '/../_lib/changelog.php';
require __DIR__ . '/../_lib/releases.php';
require __DIR__ . '/../_lib/layout.php';

$published = [];
foreach (releases() as $r) $published[$r['tag']] = $r;

page_start('cmd releases', "What's new in each release of cmd.", 'releases/');
?>
<h1>Releases</h1>
<p class="lede">What's new in each release of cmd.</p>
<?php foreach (changelog() as $i => $c): $tag = 'v' . $c['version']; $r = $published[$tag] ?? null; ?>
<section class="release<?= $i === 0 && $r ? ' latest' : '' ?>" id="<?= h($tag) ?>">
  <div class="head">
    <h2><a href="#<?= h($tag) ?>"><?= h($c['version']) ?></a></h2>
    <?= $i === 0 && $r ? '<span class="pill accent">Latest</span>' : '' ?>
    <time datetime="<?= h($c['date']) ?>"><?= h($c['date']) ?></time>
    <?php if ($r && $r['dmg']): ?><a class="button<?= $i === 0 ? '' : ' secondary small' ?>" href="<?= h($r['dmg']) ?>">Download</a><?php endif ?>
  </div>
  <div class="notes"><?= notes_html($c['notes']) ?></div>
</section>
<?php endforeach ?>
<p class="more"><a href="https://github.com/janoelze/cmd/releases">All releases on GitHub →</a></p>
<script>
// Dates as the reader writes them ("Oct 4, 2026").
for (const t of document.querySelectorAll(".release time")) {
  const d = new Date(t.dateTime + "T12:00:00");
  if (!isNaN(d)) t.textContent = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
</script>
<?php
page_end();

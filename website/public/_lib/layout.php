<?php
// Page chrome shared by the product page and the usage page: head, nav, footer
// and the stylesheet (light and dark from the same tokens).

declare(strict_types=1);

function h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES);
}

function page_start(string $title, string $description, string $current): void
{
    $nav = ['' => 'cmd', 'usage/' => 'Usage'];
    ?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= h($title) ?></title>
<meta name="description" content="<?= h($description) ?>">
<style>
:root {
  --bg: #fbfbfa; --surface: #ffffff; --ink: #1b1b1a; --ink-2: #5d5d58; --ink-3: #8a8a84;
  --line: #e4e4e0; --accent: #2f6fd6; --accent-soft: #dbe6f8;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --surface: #1f1f1e; --ink: #ededea; --ink-2: #a8a8a2; --ink-3: #75756f;
    --line: #333331; --accent: #6b9cf0; --accent-soft: #24324a; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); }
main, header, footer { max-width: 880px; margin: 0 auto; padding: 0 16px; }
header { display: flex; gap: 20px; align-items: baseline; padding-top: 28px; padding-bottom: 8px; }
header a { color: var(--ink-2); text-decoration: none; font-weight: 500; }
header a.current, header a:hover { color: var(--ink); }
header a.brand { font-family: var(--mono); font-weight: 700; color: var(--ink); }
a { color: var(--accent); }
h1 { font-size: 30px; line-height: 1.2; margin: 32px 0 8px; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 36px 0 12px; }
p.lede { color: var(--ink-2); font-size: 17px; margin: 0 0 24px; max-width: 60ch; }
.muted { color: var(--ink-3); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.tile .label { color: var(--ink-2); font-size: 13px; }
.tile .value { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.bars { display: grid; grid-template-columns: minmax(70px, max-content) 1fr max-content; gap: 6px 10px; align-items: center; font-size: 13px; }
.bars .track { display: block; height: 10px; }
.bars .fill { display: block; height: 100%; background: var(--accent); border-radius: 0 4px 4px 0; min-width: 2px; }
.bars .n { font-variant-numeric: tabular-nums; color: var(--ink-2); text-align: right; }
.bars .k { font-family: var(--mono); }
.daily { display: flex; align-items: flex-end; gap: 2px; height: 140px; }
.daily .col { flex: 1; height: 100%; display: flex; align-items: flex-end; }
.daily .col span { display: block; width: 100%; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 1px; }
.daily .col:hover span { background: var(--ink); }
.axis { display: flex; justify-content: space-between; color: var(--ink-3); font-size: 12px; margin-top: 6px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
td, th { text-align: left; padding: 8px 12px 8px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--ink-2); font-weight: 500; font-size: 13px; }
td.num { font-variant-numeric: tabular-nums; }
.tag { font-family: var(--mono); }
.pill { font-size: 11px; color: var(--ink-2); border: 1px solid var(--line); border-radius: 99px; padding: 1px 7px; margin-left: 6px; }
.button { display: inline-block; background: var(--ink); color: var(--bg); text-decoration: none; padding: 9px 16px; border-radius: 8px; font-weight: 500; }
footer { color: var(--ink-3); font-size: 13px; padding-top: 48px; padding-bottom: 32px; }
</style>
</head>
<body>
<header>
<?php foreach ($nav as $href => $label): ?>
  <a href="/cmd/<?= $href ?>" class="<?= $href === '' ? 'brand' : '' ?> <?= $href === $current ? 'current' : '' ?>"><?= h($label) ?></a>
<?php endforeach ?>
  <a href="https://github.com/janoelze/cmd">GitHub</a>
</header>
<main>
<?php
}

function page_end(): void
{
    ?>
</main>
<footer>cmd · a terminal and coding-agent workbench for macOS · <a href="https://endtime-instruments.org">endtime instruments</a></footer>
</body>
</html>
<?php
}

/**
 * Labelled horizontal bars, largest first. Rows are numbers, or
 * ['count' => n, 'share' => 0..1] to say what share of installs did it too.
 */
function bars(array $rows, string $empty = 'Nothing yet.'): void
{
    if (!$rows) {
        echo '<p class="muted">' . h($empty) . '</p>';
        return;
    }
    $n = fn($r) => is_array($r) ? $r['count'] : $r;
    uasort($rows, fn($a, $b) => $n($b) <=> $n($a));
    $max = max(array_map($n, $rows)) ?: 1;
    echo '<div class="bars">';
    foreach ($rows as $k => $r) {
        $w = round($n($r) / $max * 100, 1);
        $label = number_format($n($r)) . (is_array($r) ? ' <span class="muted">· ' . round($r['share'] * 100) . '% of installs</span>' : '');
        echo '<span class="k">' . h((string) $k) . '</span><span class="track"><span class="fill" style="width:' . $w . '%" title="' . h("$k: " . $n($r)) . '"></span></span><span class="n">' . $label . '</span>';
    }
    echo '</div>';
}

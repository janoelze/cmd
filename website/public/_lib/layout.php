<?php
// Page chrome shared by the product page and the usage page: head, nav
// and the stylesheet (dark only, see :root).

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
  /* The app's Pastel Dark theme (packages/ui/src/themes/pastel-dark.ts), on a
     background darker than the app's own #0a0b0c, so the screenshots sit on
     the page as windows. Dark only. */
  color-scheme: dark;
  --bg: #050506; --surface: #121314; --ink: #e0e4e8; --ink-2: #a4aab3; --ink-3: #7d838c;
  --line: #1f2124; --accent: #71bef2; --link: #8ad4f5; --accent-soft: #15283a; --on-accent: #121314;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans); }
main, header { max-width: 880px; margin: 0 auto; padding: 0 16px; }
main { padding-bottom: 48px; }
header { display: flex; gap: 18px; align-items: baseline; padding-top: 20px; padding-bottom: 4px; font-size: 14px; }
header a { color: var(--ink-2); text-decoration: none; font-weight: 500; }
header a.current, header a:hover { color: var(--ink); }
header a.brand { font-family: var(--mono); font-weight: 700; color: var(--ink); }
a { color: var(--link); }
h1 { font-size: 28px; line-height: 1.2; margin: 24px 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 28px 0 10px; }
p.lede { color: var(--ink-2); font-size: 16px; margin: 0 0 18px; max-width: 60ch; }
code { font-family: var(--mono); font-size: 0.9em; color: var(--ink); }
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
.daily .col:hover span { background: var(--link); }
.axis { display: flex; justify-content: space-between; color: var(--ink-3); font-size: 12px; margin-top: 6px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
td, th { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--ink-2); font-weight: 500; font-size: 13px; }
td.num { font-variant-numeric: tabular-nums; }
.tag { font-family: var(--mono); }
.pill { font-size: 11px; color: var(--ink-2); border: 1px solid var(--line); border-radius: 99px; padding: 1px 7px; margin-left: 6px; }
.cta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; margin: 0 0 8px; }
.button.secondary { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }
.hero-shots { border-radius: 1.196% / 1.895%; } /* 18px window corners on the 1505×950 screenshots, at any size */
.hero-shots::after { content: ""; position: absolute; inset: 0; z-index: 1; border-radius: inherit; border: 1px solid rgb(255 255 255 / 0.16); pointer-events: none; } /* lightens the screenshot's own edge, whatever its colour */
.hero-shots { position: relative; width: min(1400px, calc(100vw - 32px)); margin: 48px 0 48px 50%; transform: translateX(-50%); }
.hero-shots img { display: block; width: 100%; height: auto; border-radius: inherit; opacity: 0; transition: opacity 0.9s ease; }
.hero-shots img + img { position: absolute; inset: 0; }
.hero-shots img.on { opacity: 1; }
h2.section { font-size: 18px; margin: 40px 0 14px; }
.features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px 28px; margin-bottom: 8px; }
.features h3 { font-size: 14px; font-weight: 500; margin: 0 0 2px; }
.features p { font-size: 13px; line-height: 1.45; color: var(--ink-2); margin: 0; }
@media (max-width: 640px) {
  h1 { font-size: 24px; margin-top: 18px; }
  p.lede { font-size: 15px; }
  .features { grid-template-columns: 1fr 1fr; gap: 14px 16px; }
}
.button { display: inline-block; background: var(--accent); color: var(--on-accent); text-decoration: none; padding: 9px 16px; border-radius: 8px; font-weight: 500; }
.releases { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.releases li { display: grid; grid-template-columns: 5.5em 1fr auto 4.5em auto; align-items: center; gap: 16px; padding: 8px 10px 8px 14px; font-size: 14px; }
.releases li + li { border-top: 1px solid var(--line); }
.releases li.latest { background: var(--surface); }
.releases .tag { color: var(--ink); text-decoration: none; font-size: 13px; }
.releases .tag:hover { color: var(--link); }
.releases time { color: var(--ink-3); font-variant-numeric: tabular-nums; }
.releases .size { color: var(--ink-3); font-variant-numeric: tabular-nums; text-align: right; }
.button.small { padding: 4px 12px; font-size: 13px; border-radius: 6px; }
.button.secondary:hover { box-shadow: inset 0 0 0 1px var(--ink-3); }
.releases .pill { margin-left: 0; }
.pill.accent { color: var(--accent); border-color: var(--accent-soft); background: var(--accent-soft); }
.pill + .pill { margin-left: 4px; }
p.more { margin: 10px 0 0; font-size: 14px; }
p.more a { color: var(--ink-2); text-decoration: none; }
p.more a:hover { color: var(--link); }
@media (max-width: 640px) {
  .releases li { grid-template-columns: 5em 1fr 4.5em auto; gap: 12px; padding: 8px 8px 8px 12px; }
  .releases time { display: none; }
}
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

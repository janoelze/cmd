<?php
// Page chrome shared by the product page and the usage page: head, nav
// and the stylesheet (dark only, see :root).

declare(strict_types=1);

/** Where the site is served; social previews need absolute URLs. */
const SITE_URL = 'https://endtime-instruments.org/cmd/';

function h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES);
}

function page_start(string $title, string $description, string $current): void
{
    $nav = ['' => 'cmd', 'usage/' => 'Usage'];
    $GLOBALS['site_root'] = str_repeat('../', substr_count($current, '/')); // relative, so it works under /cmd/ and locally
    $url = SITE_URL . $current;
    ?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= h($title) ?></title>
<meta name="description" content="<?= h($description) ?>">
<link rel="canonical" href="<?= h($url) ?>">
<meta name="theme-color" content="#050506">
<link rel="icon" type="image/png" sizes="64x64" href="<?= h($GLOBALS['site_root']) ?>assets/icon-64.png">
<link rel="apple-touch-icon" href="<?= h($GLOBALS['site_root']) ?>assets/icon-180.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="cmd">
<meta property="og:title" content="<?= h($title) ?>">
<meta property="og:description" content="<?= h($description) ?>">
<meta property="og:url" content="<?= h($url) ?>">
<meta property="og:image" content="<?= h(SITE_URL) ?>assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The cmd app icon: a ⌘ on a dark rounded square">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="<?= h($title) ?>">
<meta name="twitter:description" content="<?= h($description) ?>">
<meta name="twitter:image" content="<?= h(SITE_URL) ?>assets/og.png">
<style>
:root {
  /* The app's Pastel Dark theme (packages/ui/src/themes/pastel-dark.ts), on a
     background darker than the app's own #0a0b0c, so the screenshots sit on
     the page as windows. Dark only. */
  color-scheme: dark;
  --bg: #050506; --surface: #121314; --ink: #e0e4e8; --ink-2: #a4aab3; --ink-3: #7d838c;
  --line: #1f2124; --accent: #71bef2; --link: #8ad4f5; --accent-soft: #15283a; --on-accent: #121314;
  /* One type scale for the whole site: text at 14-15px, the title a little more. */
  --fs-xs: 12px; --fs-sm: 14px; --fs-base: 14px; --fs-lede: 15px; --fs-h2: 15px; --fs-h1: 20px;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: var(--fs-base)/1.7 var(--sans); }
main, header { max-width: 880px; margin: 0 auto; padding: 0 16px; }
main { padding-bottom: 8px; }
footer { display: flex; justify-content: center; padding: 48px 16px 40px; }
footer img { opacity: 0.3; transition: opacity 0.3s; }
footer img:hover { opacity: 0.85; }
header { display: flex; gap: 24px; align-items: baseline; padding-top: 20px; padding-bottom: 4px; font-size: var(--fs-base); }
header a { color: var(--ink-2); text-decoration: none; font-weight: 500; }
header a.current, header a:hover { color: var(--ink); }
header a.brand { font-family: var(--mono); font-weight: 700; color: var(--ink); }
a { color: var(--link); }
h1 { font-size: var(--fs-h1); line-height: 1.3; margin: 24px 0 6px; }
h2 { font-size: var(--fs-h2); margin: 36px 0 12px; }
p.lede { color: var(--ink-2); font-size: var(--fs-lede); margin: 0 0 18px; max-width: 60ch; }
code { font-family: var(--mono); font-size: 0.9em; color: var(--ink); }
/* A keycap, like the app's Kbd (packages/ui, .ui-kbd). */
kbd { display: inline-block; min-width: 1.6em; padding: 0 0.4em; font: 0.92em/1.5 var(--sans); letter-spacing: 0.04em; text-align: center; color: var(--ink); background: var(--surface); border-radius: 4px; box-shadow: inset 0 0 0 1px var(--kbd-edge), inset 0 -1px 0 var(--kbd-edge); --kbd-edge: color-mix(in srgb, var(--ink-3) 40%, transparent); }
.muted { color: var(--ink-3); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.card.scroll { overflow-x: auto; }
.note { margin-top: 24px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.tile .value { line-height: 1.4; }
.tile .label { color: var(--ink-2); font-size: var(--fs-sm); }
.tile .value { font-size: var(--fs-h1); font-weight: 600; font-variant-numeric: tabular-nums; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 8px; }
.grid2 h2 { margin-top: 28px; }
.bars { display: grid; grid-template-columns: minmax(64px, max-content) 1fr max-content; gap: 2px 10px; align-items: center; font-size: var(--fs-sm); }
.bars .track { display: block; height: 6px; }
.bars .fill { display: block; height: 100%; background: var(--accent); border-radius: 3px; min-width: 3px; }
.bars .n { font-variant-numeric: tabular-nums; color: var(--ink-2); text-align: right; }
.bars .k, td.tag { font-family: var(--mono); font-size: 0.92em; }
.daily { display: flex; align-items: flex-end; gap: 3px; height: 90px; }
.daily .col { flex: 1; height: 100%; display: flex; align-items: flex-end; }
.daily .col span { display: block; width: 100%; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 1px; }
.daily .col:hover span { background: var(--link); }
.axis { display: flex; justify-content: space-between; color: var(--ink-3); font-size: var(--fs-xs); margin-top: 4px; }
table { width: 100%; border-collapse: collapse; font-size: var(--fs-base); }
td, th { text-align: left; padding: 4px 12px 4px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--ink-2); font-weight: 500; font-size: var(--fs-sm); }
td.num { font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: 0; }
.tag { font-family: var(--mono); }
.pill { font-size: var(--fs-xs); color: var(--ink-2); border: 1px solid var(--line); border-radius: 99px; padding: 1px 7px; margin-left: 6px; }
.cta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; margin: 0 0 8px; }
.button.secondary { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }
.hero-shots { border-radius: 1.2% / 2%; } /* 18px window corners on the 1498×898 screenshots, at any size */
.hero-shots { display: grid; width: min(1400px, 100vw - 32px); margin-block: 48px; margin-inline: calc(50% - min(700px, 50vw - 16px)); } /* wider than main, centred on it */
.hero-shots > img, .hero-shots::after { grid-area: 1 / 1; } /* stacked in one cell */
.hero-shots img { display: block; width: 100%; height: auto; border-radius: inherit; opacity: 0; transition: opacity 0.9s ease; }
.hero-shots::after { content: ""; z-index: 1; border-radius: inherit; border: 1px solid rgb(255 255 255 / 0.16); pointer-events: none; } /* lightens the screenshot's own edge, whatever its colour */
.hero-shots img.on { opacity: 1; }
.hero-shots { transition: opacity 1.2s ease, translate 1.2s cubic-bezier(0.2, 0.7, 0.2, 1); }
.hero-shots.loading { opacity: 0; translate: 0 12px; }
@media (prefers-reduced-motion: reduce) { .hero-shots.loading { translate: none; } }
.reqs { display: grid; grid-template-columns: max-content 1fr; gap: 2px 20px; margin: 0; font-size: var(--fs-sm); }
.reqs dt { color: var(--ink-3); }
.reqs dd { margin: 0; color: var(--ink-2); }
hr { border: 0; border-top: 1px solid var(--line); margin: 40px 0; }
.why { margin-bottom: 0; }
.why h2 { margin-top: 0; }
.why .cols { columns: 2; column-gap: 36px; }
.why p { font-size: var(--fs-lede); color: var(--ink-2); margin: 0 0 14px; orphans: 2; widows: 2; }
.features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px 28px; margin-bottom: 8px; }
.features h3 { font-size: var(--fs-base); font-weight: 500; margin: 0 0 2px; }
.features h3 .pill { font-weight: 400; vertical-align: 1px; }
.features p { font-size: var(--fs-sm); color: var(--ink-2); margin: 0; }
@media (max-width: 880px) { .features { grid-template-columns: repeat(2, 1fr); } } /* three lines a blurb at most */
@media (max-width: 640px) {
  main, header { padding-inline: 24px; }
  header { padding-top: 28px; gap: 20px; }
  h1 { margin-top: 28px; }
  p.lede { margin-bottom: 22px; }
  .hero-shots { width: calc(100vw - 48px); margin-inline: calc(50% - (50vw - 24px)); margin-block: 40px; }
  .why .cols { columns: 1; }
  hr { margin: 36px 0; }
  .features { grid-template-columns: 1fr; gap: 20px; }
  footer { padding: 56px 24px 48px; }
}
.button { display: inline-flex; align-items: center; background: var(--accent); color: var(--on-accent); text-decoration: none; padding: 9px 16px; border-radius: 8px; font-weight: 500; }
.releases { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.releases li { display: grid; grid-template-columns: 5.5em 1fr auto 4.5em auto; align-items: center; gap: 16px; padding: 8px 10px 8px 14px; font-size: var(--fs-base); }
.releases li + li { border-top: 1px solid var(--line); }
.releases li.latest { background: var(--surface); }
.releases .tag { color: var(--ink); text-decoration: none; font-size: var(--fs-sm); }
.releases .tag:hover { color: var(--link); }
.releases time { color: var(--ink-3); font-variant-numeric: tabular-nums; }
.releases .size { color: var(--ink-3); font-variant-numeric: tabular-nums; text-align: right; }
.button.small { padding: 4px 12px; font-size: var(--fs-sm); border-radius: 6px; }
.button.secondary:hover { box-shadow: inset 0 0 0 1px var(--ink-3); }
.releases .pill { margin-left: 0; }
.pill.accent { color: var(--accent); border-color: var(--accent-soft); background: var(--accent-soft); }
.pill + .pill { margin-left: 4px; }
p.more { margin: 10px 0 0; font-size: var(--fs-base); }
p.more a { color: var(--ink-2); text-decoration: none; }
p.more a:hover { color: var(--link); }
@media (max-width: 640px) {
  .releases li { grid-template-columns: 5em 1fr 4.5em auto; gap: 12px; padding: 10px 10px 10px 14px; }
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
  <a href="https://discord.gg/BVQjfAFpaS">Discord</a>
</header>
<main>
<?php
}

function page_end(): void
{
    ?>
</main>
<footer><img src="<?= h($GLOBALS['site_root'] ?? '') ?>assets/hack-the-planet.svg" width="105" height="14" alt="Hack the planet" title="Hack the planet!"></footer>
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

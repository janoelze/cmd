<?php
// endtime-instruments.org/cmd: the product page and the list of releases from
// GitHub (lib/releases.php). Copy follows docs/15-positioning.md; the feature
// grid comes from _lib/features.json, which the release skill keeps current.

declare(strict_types=1);
require __DIR__ . '/_lib/releases.php';
require __DIR__ . '/_lib/layout.php';

/** The feature grid: [{title, text, badge?}]. */
function features(): array
{
    return json_decode((string) file_get_contents(__DIR__ . '/_lib/features.json'), true, 8, JSON_THROW_ON_ERROR)['features'];
}

$releases = releases();
$latest = null;
foreach ($releases as $r) {
    if (!$r['prerelease']) {
        $latest = $r;
        break;
    }
}

page_start('cmd', 'A software workbench for macOS. Terminals, coding agents, browser, editor and widgets, side by side in one Space per project, arranged however you work.', '');
?>
<h1>cmd</h1>
<p class="lede">A software workbench for macOS. Terminals, coding agents, browser, editor and widgets, side by side in one Space per project, arranged however you work.</p>
<p class="cta">
<?php if ($latest): ?>
  <a class="button" href="<?= h($latest['dmg'] ?? $latest['url']) ?>">Download <?= h($latest['tag']) ?></a>
<?php endif ?>
  <a class="button secondary" href="https://github.com/janoelze/cmd">View on GitHub</a>
</p>

<div class="hero-shots" aria-roledescription="slideshow">
  <img class="on" src="shots/strip.png" width="1498" height="898" alt="The strip: a Claude Code session, a shader widget, the file browser and a CI widget; four agents in the sidebar">
  <img src="shots/grid-dark.png" width="1498" height="898" alt="The grid: usage and CI widgets, four Claude Code sessions, a shader, the file browser and a shell">
  <img src="shots/light-agents.png" width="1498" height="898" alt="A light theme: a Claude Code session, the Agent Activity widget and a CI widget">
  <img src="shots/usage.png" width="1498" height="898" alt="The usage widget, a Claude Code session and a shader widget in the strip">
  <img src="shots/search.png" width="1498" height="898" alt="Searching files from the palette: json files and matching lines across the repo">
  <img src="shots/light-files.png" width="1498" height="898" alt="A light theme: the file browser on the repo next to a CI widget">
  <img src="shots/canvas-shader.png" width="1498" height="898" alt="The canvas: a shader widget and the file browser">
  <img src="shots/strip-agents.png" width="1498" height="898" alt="The strip: two Claude Code sessions side by side with a CI widget">
  <img src="shots/weather.png" width="1498" height="898" alt="A weather widget next to a Claude Code session, in a warm theme">
  <img src="shots/light-palette.png" width="1498" height="898" alt="The command palette over the canvas, in a light theme">
  <img src="shots/json.png" width="1498" height="898" alt="A JSON window on package.json next to the Navigator and a CI widget">
  <img src="shots/search-shader.png" width="1498" height="898" alt="File search over the canvas, with a shader widget behind">
  <img src="shots/maps.png" width="1498" height="898" alt="The strip: Google Maps in a browser window between the Navigator and a CI widget">
  <img src="shots/site.png" width="1498" height="898" alt="The strip: this website in a browser window between the Navigator, a usage widget and a CI widget">
  <img src="shots/canvas-commands.png" width="1498" height="898" alt="The canvas: the file browser, a Hacker widget, the Commands widget and a Claude Code session, with the Navigator docked on the right">
  <img src="shots/strip-hacker.png" width="1498" height="898" alt="The strip: a Claude Code session and a Hacker widget between the file browser and the Navigator">
</div>
<script>
// Shuffle the hero screenshots, fade the gallery in from a blur once the first has loaded,
// then crossfade through them; reduced motion shows one at random. Without
// script the first one shows.
(() => {
  const box = document.querySelector(".hero-shots");
  const shots = [...box.children];
  for (let i = shots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shots[i], shots[j]] = [shots[j], shots[i]];
  }
  for (const s of shots) { s.classList.remove("on"); box.append(s); }
  shots[0].classList.add("on");
  // Hidden until the first screenshot has loaded, then faded in from a blur; the
  // crossfade starts from there.
  const cycle = shots.length > 1 && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  let shown = false;
  const reveal = () => {
    if (shown) return;
    shown = true;
    box.classList.add("revealing");
    box.classList.remove("loading");
    setTimeout(() => box.classList.remove("revealing"), 1800); // after the 1.6 s transition
    if (!cycle) return;
    let i = 0;
    setInterval(() => {
      if (document.hidden) return;
      shots[i].classList.remove("on");
      i = (i + 1) % shots.length;
      shots[i].classList.add("on");
    }, 3500);
  };
  box.classList.add("loading");
  shots[0].decode().then(reveal, reveal);
  setTimeout(reveal, 3000);
})();
</script>

<section class="why">
<h2>Why I'm building this</h2>
<div class="cols">
<p>For better or worse, I'm going to spend the rest of my working life in terminals. That's where most of my work happens, and it won't change anytime soon. What's increasingly silly is how ineffective my workflow around them has become.</p>
<p>I'm an engineer and designer with 15 years of experience, and yet I found myself shortcut-switching between tabs like a lunatic, trying to remember which session was doing what. Occasionally, I'd stumble across one that had been waiting for my feedback for 30 minutes. I'm objectively a power user, but I didn't feel like one.</p>
<p>Looking at newer terminal emulators and agent tools didn't help much either. Agent orchestrators often impose their own workflows, with crazy levels of engineering and UI complexity. I didn't want another system to manage my work. I wanted a better way to work with the tools I already use.</p>
<p>So I started building cmd, a software workbench that embraces UNIX at its core and brings my tools together in one place.</p>
<p>A Space per project holds everything I'm working on: terminals, browsers, text editors, and more. There are a few view modes, but the Strip, inspired by <a href="https://www.youtube.com/watch?v=TOPfzaKGWK8">PaperWM</a>, is by far my favorite. Windows sit side by side in a row you scroll through, making it easy to keep multiple terminals, agents, and a browser in view without constantly losing your bearings.</p>
<p>Enable AI in the settings and cmd starts understanding what's happening across your workspaces. It recognizes terminals running agents, helps you keep track of what they're doing, surfaces sessions that need your attention, and suggests smart actions.</p>
<p>Most of what I open stays inside cmd, too. Open a file from your shell and it appears in the current Space, whether it's text, Markdown, JSON, or a URL in the browser.</p>
<p>With Magic Widgets, you can prompt new widgets into existence on the spot: open merge requests, queue depth, recent CI runs, or whatever else you need. The built-in agent builds them on top of tools already on your machine, from <code>gh</code> and <code>kubectl</code> to your own scripts. Widgets join your library and adapt to your theme, ready to use again.</p>
<p>I'm not trying to build another agent orchestrator. Those tend to impose workflows that can become obsolete with the next model or tool. cmd deliberately stays unopinionated. It bets on terminals and the tools you already know, and on the idea that they'll still matter when the next model arrives.</p>
<p>I'm building cmd mostly for myself, in the open. But I'm hoping it fits your workflow, too.</p>
</div>
</section>

<hr>

<div class="features">
<?php foreach (features() as $f): ?>
  <div><h3><?= h($f['title']) ?><?php if (isset($f['badge'])): ?> <span class="pill"><?= h($f['badge']) ?></span><?php endif ?></h3><p><?= rich($f['text']) ?></p></div>
<?php endforeach ?>
</div>

<h2>Releases</h2>
<?php if (!$releases): ?>
<p class="muted">The release list is unavailable right now. See <a href="https://github.com/janoelze/cmd/releases">GitHub</a>.</p>
<?php else: ?>
<ol class="releases">
<?php foreach (array_slice($releases, 0, 6) as $r): ?>
  <li<?= $r === $latest ? ' class="latest"' : '' ?>>
    <a class="tag" href="<?= h($r['url']) ?>"><?= h($r['tag']) ?></a>
    <span class="badges"><?= $r === $latest ? '<span class="pill accent">Latest</span>' : '' ?><?= $r['prerelease'] ? '<span class="pill">Pre-release</span>' : '' ?></span>
    <time datetime="<?= h($r['published']) ?>"><?= h($r['date']) ?></time>
    <span class="size"><?= $r['size'] ? h(number_format($r['size'] / 1048576)) . ' MB' : '' ?></span>
    <?php if ($r['dmg']): ?><a class="button secondary small" href="<?= h($r['dmg']) ?>">Download</a><?php else: ?><span></span><?php endif ?>
  </li>
<?php endforeach ?>
</ol>
<p class="more"><a href="releases/">What's new in every release →</a></p>
<script>
// Release times in the reader's time zone ("Oct 4, 22:58").
for (const t of document.querySelectorAll(".releases time")) {
  const d = new Date(t.dateTime);
  if (!isNaN(d)) t.textContent = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
</script>
<?php endif ?>
<h2>System requirements</h2>
<dl class="reqs">
  <div><dt>Mac</dt><dd>Apple silicon</dd></div>
  <div><dt>macOS</dt><dd>13 or later</dd></div>
  <div><dt>Disk</dt><dd>350 MB</dd></div>
  <div><dt>Optional</dt><dd>Anthropic or OpenAI API key</dd></div>
</dl>
<?php
page_end();
